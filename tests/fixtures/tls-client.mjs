import { createExecutor } from '../../apps/server/dist/monitoring/http.js';
import { monitorCreateSchema } from '@pulse/contracts';
const executor=createExecutor({mode:'allow-private',cidrs:['127.0.0.1/32']},async()=>['127.0.0.1']);
const observation=await executor(monitorCreateSchema.parse({name:'TLS fixture',url:`https://fixture.example:${Number(process.argv[2])}/health`}),new AbortController().signal);
console.log(JSON.stringify(observation));
