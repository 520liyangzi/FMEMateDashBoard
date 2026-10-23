import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
const target='http://127.0.0.1:8000';
export default defineConfig({plugins:[react()],build:{rollupOptions:{output:{inlineDynamicImports:true}}},server:{allowedHosts:['terminal.local'],proxy:{'/api':{target,changeOrigin:true,configure(proxy){proxy.on('proxyReq',(forward,req)=>{const origin=req.headers.origin;if(origin&&req.headers['sec-fetch-site']!=='cross-site'){try{if(['localhost','127.0.0.1','terminal.local','[::1]'].includes(new URL(origin).hostname))forward.setHeader('Origin',target)}catch{}}})}},'/uploads':target}}});
