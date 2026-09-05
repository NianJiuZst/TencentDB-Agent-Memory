/** Build real MemoryCore recall contexts from public, earlier task experience. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { input:{type:'string'}, output:{type:'string'}, 'core-root':{type:'string',default:process.cwd()}, arm:{type:'string',default:'optimized'} } });
if (!values.input || !values.output) throw new Error('--input and --output required');
const input = JSON.parse(await readFile(values.input,'utf8'));
const core=path.resolve(values['core-root']!);
const load=(p:string)=>import(pathToFileURL(path.join(core,p)).href);
const [{parseConfig},{VectorStore},{writeMemory},{performAutoRecall}]=await Promise.all([load('src/config.ts'),load('src/core/store/sqlite.ts'),load('src/core/record/l1-writer.ts'),load('src/core/hooks/auto-recall.ts')]);
const root=await mkdtemp(path.join(os.tmpdir(),'tdai-agent-memory-'));
const results=[];
try {
 for (const item of input.tasks) {
  const baseDir=path.join(root,item.instance_id);await mkdir(baseDir);
  const store=new VectorStore(path.join(baseDir,'memory.db'),0);store.init();
  try {
   for (const record of item.records) {
    const stored=await writeMemory({ memory:{content:record.content,type:'work_fact',priority:80,scene_name:'repository-experience',source_message_ids:[],metadata:{activity_start_time:record.created_at,source_task_id:record.source_task_id}},decision:{record_id:record.id,action:'store',target_ids:[]},baseDir,sessionKey:'benchmark-history',sessionId:'benchmark-history',teamId:'benchmark',userId:'benchmark',agentId:'coding-agent',vectorStore:store,versionContext:record.versionContext,lifecycleFeedbackEnabled:false });
    if(!stored)throw new Error('memory write failed');
   }
   const cfg=parseConfig({recall:{strategy:'keyword',maxResults:5,scoreThreshold:0,maxChars:12000,lifecycle:{enabled:true,versionAwareMode:values.arm==='global'?'off':'strict',autoDetectGit:false,versionCandidateMultiplier:4,maxVersionStates:6,timeoutMs:100}}});
   const start=performance.now();
   const recalled=await performAutoRecall({userText:item.query,actorId:'benchmark',sessionKey:'benchmark-current',cfg,pluginDataDir:baseDir,vectorStore:store,profileIsolation:{teamId:'benchmark',agentId:'coding-agent'},versionContext:item.current});
   if(recalled?.error)throw new Error(JSON.stringify(recalled.error));
   results.push({instance_id:item.instance_id,arm:values.arm,memoryWrites:item.records.length,recallMs:performance.now()-start,current:item.current,context:recalled?.prependContext??'',memoryIds:(recalled?.recalledL1Memories??[]).map((r:any)=>r.id),decision:recalled?.lifecycleDecision??null});
  } finally {store.close();}
 }
} finally {await rm(root,{recursive:true,force:true});}
const hashes=Object.fromEntries(await Promise.all(['src/core/hooks/auto-recall.ts','src/core/lifecycle/version-scope.ts'].map(async f=>[f,createHash('sha256').update(await readFile(path.join(core,f))).digest('hex')])));
await mkdir(path.dirname(path.resolve(values.output)),{recursive:true});
await writeFile(values.output,JSON.stringify({arm:values.arm,sourceHashes:hashes,rows:results},null,2)+'\n');
console.log(JSON.stringify({arm:values.arm,cases:results.length,withMemory:results.filter(x=>x.memoryIds.length).length}));
