import {spawn,spawnSync} from 'node:child_process';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const children=[];
function stop(){for(const child of children)child.kill();}
process.on('SIGINT',()=>{stop();process.exit(0)});process.on('SIGTERM',()=>{stop();process.exit(0)});process.on('exit',stop);
async function ready(){try{const res=await fetch('http://127.0.0.1:8000/api/state');return res.ok&&typeof(await res.json()).total==='number'}catch{return false}}
if(!await ready()){
 const choices=process.platform==='win32'?[['py','-3'],['python']]:[['python3'],['python']];
 const selected=choices.find(c=>spawnSync(c[0],[...c.slice(1),'-c','import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'],{stdio:'ignore'}).status===0);
 if(!selected){console.error('Python 3.10+ is required for the development API server.');process.exit(1)}
 const server=spawn(selected[0],[...selected.slice(1),'server.py'],{cwd:root,stdio:'inherit'});children.push(server);
 let online=false;for(let attempt=0;attempt<50;attempt++){if(await ready()){online=true;break}await new Promise(resolve=>setTimeout(resolve,100))}
 if(!online){console.error('Could not start API on port 8000.');process.exit(1)}
}
const vite=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),...process.argv.slice(2)],{cwd:root,stdio:'inherit'});children.push(vite);
vite.on('exit',code=>{stop();process.exit(code||0)});
