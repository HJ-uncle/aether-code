import fs from 'node:fs';
import path from 'node:path';
const out = process.argv[2];
const repos = ['paperclipai/paperclip','gastownhall/gastown','OpenBMB/ChatDev','FoundationAgents/MetaGPT','OpenHands/OpenHands','crewAIInc/crewAI','langchain-ai/langgraph-supervisor-py','langchain-ai/langgraph-swarm-py','microsoft/magentic-ui','microsoft/agent-framework','microsoft/autogen'];
async function get(url) { const r=await fetch(url,{headers:{'User-Agent':'Aether-Architecture-Research'}}); if(!r.ok)throw Error(`${r.status}: ${url}`); return await r.text(); }
const all=[];
for(let i=0;i<repos.length;i+=3){await Promise.all(repos.slice(i,i+3).map(async repo=>{try { const meta=JSON.parse(await get(`https://api.github.com/repos/${repo}`)); const commits=JSON.parse(await get(`https://api.github.com/repos/${meta.full_name}/commits?per_page=1`)); const sha=commits[0].sha; const dir=path.join(out,meta.full_name.replace('/','__'));fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({...meta,researchFetchedAt:new Date().toISOString(),researchCommit:sha,researchCommitDate:commits[0].commit.committer.date},null,2)); let readme=''; let readmeFile=''; for(const candidate of ['README.md','readme.md','README.MD']){try{readme=await get(`https://raw.githubusercontent.com/${meta.full_name}/${sha}/${candidate}`);readmeFile=candidate;break;}catch{}}
fs.writeFileSync(path.join(dir,'README.snapshot.md'),readme); const rec={repo:meta.full_name,sha,commitDate:commits[0].commit.committer.date,archived:meta.archived,license:meta.license?.spdx_id,stars:meta.stargazers_count,readmeFile,readmeBytes:Buffer.byteLength(readme)};all.push(rec);console.log(JSON.stringify(rec));
}catch(e){all.push({repo,error:e.message});console.log(JSON.stringify({repo,error:e.message}));}}));}
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(all,null,2));
