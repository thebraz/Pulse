#!/bin/bash
# Disposable filesystem faults only. Run as root in a private mount namespace.
set -euo pipefail
test "$(id -u)" = 0
test "$(readlink /proc/self/ns/mnt)" != "$(readlink /proc/1/ns/mnt)"
root=${PULSE_STORAGE_CHROOT:?Set the isolated Ubuntu 24.04 chroot directory}
destination=${PULSE_STORAGE_PROJECT:?Set the evidence destination project directory}
case "$root" in /var/tmp/pulse-ubuntu24-*/root) ;; *) echo 'Unsafe storage fixture root' >&2; exit 1;; esac
source=$root/tmp/pulse-source
test -f "$source/scripts/storage-fault-worker.mjs"
test -d "$destination/docs/evidence"
test -d "$destination/.private"
control_host=$(mktemp -d "$root/tmp/pulse-storage-control-XXXXXXXX")
control=${control_host#"$root"}
mount_host=$(mktemp -d "$root/tmp/pulse-storage-mount-XXXXXXXX")
mount_dir=${mount_host#"$root"}
image=$(mktemp /var/tmp/pulse-storage-image-XXXXXXXX)
loop=''
mapper="pulse-storage-fault-$$"
mapper_created=0
pid=''
cleanup() {
    if test -n "$pid" && kill -0 "$pid" 2>/dev/null; then kill "$pid"; wait "$pid" || true; fi
    if mountpoint -q "$mount_host"; then umount "$mount_host" || true; fi
    if test "$mapper_created" = 1; then dmsetup remove "$mapper" || true; fi
    if test -n "$loop"; then losetup -d "$loop"; fi
    case "$image" in /var/tmp/pulse-storage-image-*) rm -f -- "$image";; *) exit 1;; esac
    rmdir "$mount_host" 2>/dev/null || true
}
trap cleanup EXIT
mount -t proc proc "$root/proc"
mount --rbind /dev "$root/dev"
wait_stage() {
    local stage=$1
    for unused in $(seq 1 600); do
        test -f "$control_host/$scenario/$stage" && return 0
        if ! kill -0 "$pid" 2>/dev/null; then
            cat "$control_host/$scenario/process.log"
            if test -f "$control_host/$scenario/result.json"; then cp "$control_host/$scenario/result.json" "$destination/.private/storage-fault-$scenario-failure.json"; fi
            return 1
        fi
        sleep 0.1
    done
    echo "Storage fixture deadline: $scenario $stage" >&2
    return 1
}
for scenario in full readonly ioerr; do
    mkdir "$control_host/$scenario"
    chown -R 1000:1000 "$control_host"
    if test "$scenario" = full; then
        mount -t tmpfs -o size=16m,mode=0770,uid=1000,gid=1000 tmpfs "$mount_host"
    else
        truncate -s 96M "$image"
        loop=$(losetup --find --show "$image")
        case "$loop" in /dev/loop[0-9]*) ;; *) echo 'Unexpected loop device' >&2; exit 1;; esac
        test "$(losetup -n -O BACK-FILE "$loop")" = "$image"
        mkfs.ext4 -q -F -m 0 "$loop"
        sectors=$(blockdev --getsz "$loop")
        dmsetup create "$mapper" --table "0 $sectors linear $loop 0"
        mapper_created=1
        mount -t ext4 -o errors=remount-ro "/dev/mapper/$mapper" "$mount_host"
    fi
    mkdir "$mount_host/data"
    chown 1000:1000 "$mount_host" "$mount_host/data"
    chroot --userspec=1000:1000 "$root" /usr/bin/env PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/pulse /bin/bash -c 'cd /tmp/pulse-source; exec node scripts/storage-fault-worker.mjs "$@"' storage-worker "$scenario" "$mount_dir/data" "$control/$scenario" > "$control_host/$scenario/process.log" 2>&1 &
    pid=$!
    wait_stage ready
    if test "$scenario" = full; then
        set +e
        dd if=/dev/zero of="$mount_host/fill" bs=4096 status=none 2> "$control_host/$scenario/fault.log"
        fill_status=$?
        set -e
        test "$fill_status" -ne 0
        grep -q 'No space left on device' "$control_host/$scenario/fault.log"
    elif test "$scenario" = readonly; then
        mount -o remount,ro "$mount_host"
        findmnt -no OPTIONS "$mount_host" > "$control_host/$scenario/fault.log"
        grep -q 'ro' "$control_host/$scenario/fault.log"
    else
        dmsetup suspend --noflush "$mapper"
        dmsetup reload "$mapper" --table "0 $sectors error"
        dmsetup resume "$mapper"
        dmsetup table "$mapper" > "$control_host/$scenario/fault.log"
        grep -q 'error' "$control_host/$scenario/fault.log"
        set +e
        dd if="/dev/mapper/$mapper" of=/dev/null bs=4096 count=1 iflag=direct status=none 2>> "$control_host/$scenario/fault.log"
        io_status=$?
        set -e
        test "$io_status" -ne 0
        grep -q 'Input/output error' "$control_host/$scenario/fault.log"
    fi
    touch "$control_host/$scenario/verify"
    wait_stage faulted
    if test "$scenario" = full; then
        rm -f -- "$mount_host/fill"
    elif test "$scenario" = readonly; then
        mount -o remount,rw "$mount_host"
    else
        dmsetup suspend --noflush "$mapper"
        dmsetup reload "$mapper" --table "0 $sectors linear $loop 0"
        dmsetup resume "$mapper"
        umount "$mount_host"
        e2fsck -p "/dev/mapper/$mapper" > "$control_host/$scenario/fs-recovery.log" 2>&1 || test "$?" = 1
        mount -t ext4 -o errors=remount-ro "/dev/mapper/$mapper" "$mount_host"
    fi
    touch "$control_host/$scenario/recover"
    wait_stage finished
    wait "$pid"
    pid=''
    cat "$control_host/$scenario/result.json"
    cp "$control_host/$scenario/result.json" "$destination/docs/evidence/stage-4-storage-$scenario.json"
    cp "$control_host/$scenario/process.log" "$destination/.private/storage-fault-$scenario.log"
    cp "$control_host/$scenario/fault.log" "$destination/.private/storage-fault-$scenario-kernel.log"
    umount "$mount_host"
    if test -n "$loop"; then dmsetup remove "$mapper"; mapper_created=0; losetup -d "$loop"; loop=''; fi
done
