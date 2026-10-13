# Security

Pulse is intended for one trusted operator on one host. It binds to loopback by default. Public-only outbound access is the default; private-network access requires explicit CIDRs. Remote access requires an operator token, declared HTTPS origin and a correctly restricted HTTPS reverse proxy.

The v0.1.0-beta.1 line is experimental, with no production support or guaranteed remediation timeline. Review the latest GitHub pre-release notes before use and report security defects privately. No stable release or critical-monitoring suitability is claimed.

Do not post credentials or exploit details in a public issue. Use [GitHub private vulnerability reporting](https://github.com/thebraz/Pulse/security/advisories) through **Security → Report a vulnerability**. Private vulnerability reporting was enabled and verified on 2026-10-12; reports are shared privately with the repository maintainers.

Include the affected version, configuration prerequisites, impact and a minimal reproduction using dummy data. Do not test someone else's endpoints or send production secrets. Acknowledgment and remediation timelines are not guaranteed for this volunteer project.
