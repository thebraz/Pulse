import {Store} from '../../apps/server/dist/persistence/store.js';
import {acquireLock} from '../../apps/server/dist/runtime/lock.js';
import {monitorCreateSchema} from '../../packages/contracts/dist/index.js';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';

// Controlled subprocess fixture: kill the process inside an actual SQLite transaction.
const [directory,boundary]=process.argv.slice(2);
if(!directory||!['inside','after'].includes(boundary))throw new Error('FIXTURE_ARGUMENTS');
await acquireLock(directory);
const store=new Store(join(directory,'pulse.sqlite')),now=Date.now();
store.execute('initialize',{now,runId:randomUUID(),fingerprint:'a'.repeat(64)});
store.execute('create',{now,input:monitorCreateSchema.parse({name:'Crash transaction',url:'https://example.com',failureThreshold:1})});
const reservation=store.execute('dispatch',{now,preferManual:false});
if(boundary==='inside'){
    store.db.function('crash_boundary',()=>{process.kill(process.pid,'SIGKILL');return 0;});
    store.db.exec('CREATE TRIGGER crash_boundary BEFORE INSERT ON incidents BEGIN SELECT crash_boundary(); END');
}
store.execute('finish',{id:reservation.check.id,now:now+1,observation:{outcome:'HTTP_ERROR',httpStatus:500,durationMs:1,redirectCount:0,errorCode:'UNEXPECTED_STATUS'}});
process.kill(process.pid,'SIGKILL');
