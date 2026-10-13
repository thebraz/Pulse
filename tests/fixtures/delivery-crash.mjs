import { Store } from '../../apps/server/dist/persistence/store.js';
import { sendWebhook } from '../../apps/server/dist/notifications/transport.js';
import { acquireLock } from '../../apps/server/dist/runtime/lock.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const [directory]=process.argv.slice(2);if(!directory)throw new Error('FIXTURE_ARGUMENTS');
await acquireLock(directory);const store=new Store(join(directory,'pulse.sqlite')),now=Date.now();store.execute('initialize',{now,runId:randomUUID(),fingerprint:'a'.repeat(64)});const d=store.execute('destinationCreate',{now,input:{name:'Crash receiver',urlSecretRef:'ops',signingSecretRef:null,enabled:true}});store.execute('destinationTest',{now,id:d.id});const job=store.execute('deliveryClaim',{now});const url=(await readFile(join(directory,'ops.url'),'utf8')).trim();const result=await sendWebhook({mode:'allow-private',cidrs:['127.0.0.1/32']},url,null,job.payloadJson,job.eventId,job.attemptCount,new AbortController().signal);if(result.status!==204)throw new Error('FIXTURE_RECEIPT_FAILED');process.send?.({code:'RECEIVED_BEFORE_COMMIT'});setInterval(()=>{},1000);
