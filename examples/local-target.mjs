import { createServer } from 'node:http';
const server=createServer((req,res)=>{res.writeHead(req.url==='/fail'?500:200,{'content-type':'application/json'});res.end('{"status":"ok"}');});
const port=Number(process.env.PORT??8081);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid example port.');
server.listen(port,'127.0.0.1',()=>console.log(`Example target listening at http://127.0.0.1:${port}/health`));
process.on('SIGINT',()=>server.close());
process.on('SIGTERM',()=>server.close());
