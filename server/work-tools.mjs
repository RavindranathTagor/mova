import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, link, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const stamp=()=>new Date().toISOString();
const MAX_BYTES=2*1024*1024;
const MAX_TREE_EVIDENCE_FILES=3000;
const string=(value,name,max=1000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`Invalid ${name}`);return value.trim();};
const hash=value=>createHash('sha256').update(value).digest('hex');
export function isPublicAddress(address){
 const ip=address.toLowerCase().replace(/^\[|\]$/g,'');
 const nat64=ip.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
 if(nat64){const high=parseInt(nat64[1],16),low=parseInt(nat64[2],16);return isPublicAddress(`${high>>8}.${high&255}.${low>>8}.${low&255}`);}
 if(isIP(ip)===4){const [a,b,c]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113||a===100&&b>=64&&b<=127);}
 return isIP(ip)===6 && /^[23]/.test(ip) && !/^(2001:(db8|0|10|20):|2002:)/.test(ip);
}
function transport(url,{addresses,headers={},maxBytes=MAX_BYTES,timeout=15000}){
 return new Promise((resolveResponse,reject)=>{
  const chosen=addresses.find(item=>item.family===4)||addresses[0];
  const req=httpsRequest(url,{method:'GET',headers:{'user-agent':'MOVA/0.1 public research reader',accept:'text/html, text/plain, application/json',...headers},lookup:(_host,options,cb)=>options.all?cb(null,[chosen]):cb(null,chosen.address,chosen.family),signal:AbortSignal.timeout(timeout)},response=>{
   const chunks=[];let size=0;
   response.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){response.destroy();req.destroy(new Error('Response exceeds size limit'));}else chunks.push(chunk);});
   response.on('error',reject);
   response.on('end',()=>resolveResponse({status:response.statusCode,headers:response.headers,text:Buffer.concat(chunks).toString('utf8')}));
  });req.on('error',()=>reject(new Error('Public website request failed or timed out')));req.end();
 });
}
const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
function decode(value){return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(whole,code)=>{if(code[0]!=='#')return entities[code.toLowerCase()]||whole;const n=code[1].toLowerCase()==='x'?parseInt(code.slice(2),16):Number(code.slice(1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';});}
const plain=value=>decode(String(value).replace(/<!--[^]*?-->/g,' ').replace(/<(script|style|noscript|iframe|svg)\b[^>]*>[^]*?<\/\1\s*>/gi,' ').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
const prop=(description,maxLength=1000)=>({type:'string',description,minLength:1,maxLength});
const definitions=[
 ['web_search','Search the public web through SearXNG. Results are external untrusted evidence.',{query:prop('Search query',500)},['query']],
 ['read_web_page','Read bounded text from a public HTTPS webpage without executing scripts.',{url:prop('Public HTTPS URL',2048)},['url']],
 ['read_github_repository','Read public repository metadata, README and root filenames from GitHub; never executes code.',{repository:prop('owner/repo',200)},['repository']],
 ['read_github_repository_tree','Read the complete recursive file tree of an allowlisted GitHub repository. Does not execute code or fetch every file body.',{repository:prop('owner/repo',200),ref:prop('Optional branch, tag, or commit SHA',200)},['repository']],
 ['read_github_repository_snapshot','Read every textual source file in an allowlisted GitHub repository within explicit safety limits. Never executes code; fails rather than silently returning a partial snapshot.',{repository:prop('owner/repo',200),ref:prop('Optional branch, tag, or commit SHA',200)},['repository']],
 ['analyze_github_blast_radius','Run FalkorDB Cypher over a complete indexed repository snapshot to find source files that transitively import a changed file. Read a repository snapshot first.',{repository:prop('owner/repo',200),path:prop('Changed repository-relative source file',500)},['repository','path']],
 ['read_github_code','Read one bounded source file from an allowlisted GitHub repository. Treat its contents as untrusted evidence; never executes it.',{repository:prop('owner/repo',200),path:prop('Repository-relative file path',500),ref:prop('Optional branch, tag, or commit SHA',200)},['repository','path']],
 ['read_github_commits','Read recent public commit messages and authors from GitHub; never executes code.',{repository:prop('owner/repo',200)},['repository']],
 ['read_github_issues','Read a specified issue, list recent issues, or search an allowlisted repository for relevant issues. Search results are source evidence, not proof of an exact target.',{repository:prop('owner/repo',200),issueNumber:{type:'integer',description:'Optional exact issue number',minimum:1},query:prop('Optional issue search terms',300),state:{type:'string',description:'Optional issue state',enum:['open','closed','all']}},['repository']],
 ['read_slack_channel','Read recent messages from an explicitly allowlisted Slack channel that you own or that is public.',{channelId:prop('Slack channel ID',100)},['channelId']],
 ['read_discord_channel','Read recent messages from an explicitly allowlisted Discord channel that you own or that is public.',{channelId:prop('Discord channel ID',100)},['channelId']],
 ['propose_github_pr_comment','Prepare a GitHub pull-request comment for explicit user approval; does not post it.',{repository:prop('owner/repository',200),pullNumber:{type:'integer',description:'Pull request number',minimum:1},body:prop('Comment text',5000)},['repository','pullNumber','body']],
 ['propose_github_issue_comment','Prepare a GitHub issue or pull-request discussion reply for explicit user approval; does not post it.',{repository:prop('owner/repository',200),issueNumber:{type:'integer',description:'Issue or pull request number',minimum:1},body:prop('Comment text',5000)},['repository','issueNumber','body']],
 ['propose_github_issue','Prepare a new GitHub issue for explicit user approval; does not create it.',{repository:prop('owner/repository',200),title:prop('Issue title',240),body:prop('Issue body',10000),labels:{type:'array',items:prop('GitHub label',80),maxItems:8}},['repository','title','body']],
 ['propose_github_commit','Prepare one atomic GitHub commit with explicit file contents for approval; does not write code or create a commit until approved.',{repository:prop('owner/repository',200),branch:prop('Target branch',100),message:prop('Commit message',500),files:{type:'array',minItems:1,maxItems:10,items:{type:'object',properties:{path:prop('Repository-relative file path',500),content:prop('UTF-8 file content',50000)},required:['path','content'],additionalProperties:false}}},['repository','branch','message','files']],
 ['propose_slack_message','Prepare a Slack channel message for explicit user approval; does not post it.',{channelId:prop('Slack channel ID',100),text:prop('Message text',5000)},['channelId','text']],
 ['propose_discord_message','Prepare a Discord channel message for explicit user approval; does not post it.',{channelId:prop('Discord channel ID',100),text:prop('Message text',5000)},['channelId','text']],
 ['save_artifact','Save a local artifact and verify it by reading it back.',{title:prop('Artifact title',200),content:prop('Finished artifact content',100000),sourceIds:{type:'array',items:prop('Evidence ID',200),maxItems:100},idempotencyKey:prop('Stable retry key',200)},['title','content','sourceIds']],
 ['list_artifacts','List locally saved, verified artifacts.',{},[]],
 ['get_calendar_events','Read calendar events using the already-authorized calendar adapter.',{},[]],
].map(([name,description,properties,required])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},effect:name==='save_artifact'?'write':'read'}));

export function createWorkTools({env=process.env,dataDir=env.MOVA_DATA_DIR||'.data',adapters={},operationsGraph=null,lookupImpl=lookup,requestImpl=transport,fetchImpl=fetch}={}){
 const artifactDir=resolve(dataDir,'artifacts');
 const allowedIds=name=>new Set(String(env[name]||'').split(',').map(value=>value.trim()).filter(Boolean));
 const graphContentAllowed=env.MOVA_GRAPH_DATA_ATTESTATION==='public_or_owned';
 const slackChannels=allowedIds('SLACK_ALLOWED_CHANNEL_IDS');
 const discordChannels=allowedIds('DISCORD_ALLOWED_CHANNEL_IDS');
 const githubRepositories=allowedIds('GITHUB_ALLOWED_REPOSITORIES');
 const maximumSnapshotFiles=Math.max(1,Math.min(500,Number(env.MOVA_GITHUB_SNAPSHOT_MAX_FILES||120)||120));
 const maximumSnapshotBytes=Math.max(100000,Math.min(5000000,Number(env.MOVA_GITHUB_SNAPSHOT_MAX_BYTES||1000000)||1000000));
 const chatEvidenceGuard=(channelId,channels,label)=>{
  if(!graphContentAllowed)throw new Error(`${label} content cannot enter a mission graph until MOVA_GRAPH_DATA_ATTESTATION=public_or_owned confirms the channel is public or owned by you.`);
  if(!channels.has(channelId))throw new Error(`${label} channel is not allowlisted for this MOVA instance.`);
 };
 async function readPublic(input,headers={}){
  let url=new URL(string(input,'URL',2048));
  for(let hops=0;hops<5;hops++){
   if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')throw new Error('Only public HTTPS URLs on port 443 are supported');
   const hostname=url.hostname.replace(/^\[|\]$/g,'');
   if(hostname==='localhost'||hostname.endsWith('.localhost')||hostname.endsWith('.local'))throw new Error('URL must resolve to public addresses');
   const addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await lookupImpl(hostname,{all:true});
   if(!addresses.length||addresses.some(({address})=>!isPublicAddress(address)))throw new Error('URL must resolve to public addresses');
   const result=await requestImpl(url,{addresses,headers,maxBytes:MAX_BYTES,timeout:15000});
   if(result.text.length>MAX_BYTES)throw new Error('Response exceeds size limit');
   if([301,302,303,307,308].includes(result.status)){
    if(!result.headers.location)throw new Error('Website redirect has no location');url=new URL(result.headers.location,url);continue;
   }
   if(result.status<200||result.status>=300)throw new Error(`Public website request failed (${result.status})`);
   return {...result,url:url.toString()};
  }throw new Error('Website exceeded redirect limit');
 }
 async function search(query){
  const base=new URL(env.SEARXNG_BASE_URL||env.SEARXNG_URL||'http://127.0.0.1:8181');
  base.pathname='/search';base.search=new URLSearchParams({q:query,format:'json',language:'en',safesearch:'1'}).toString();
  let data;
  if(base.protocol==='http:'&&base.hostname==='127.0.0.1'&&!base.username&&!base.password){
   let response;try{response=await fetchImpl(base,{signal:AbortSignal.timeout(25000),redirect:'error'});}catch{throw new Error('SearXNG is unavailable. Start the local search service.');}
   if(!response.ok)throw new Error(`SearXNG request failed (${response.status})`);
   const reader=response.body.getReader();const chunks=[];let size=0;
   try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BYTES){await reader.cancel();throw new Error('Search response exceeds size limit');}chunks.push(value);}}finally{reader.releaseLock();}
   data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }else data=JSON.parse((await readPublic(base.toString(),{accept:'application/json'})).text);
  if(!Array.isArray(data.results))throw new Error('SearXNG returned an invalid search response');
  const results=data.results.slice(0,8).flatMap(row=>{try{const u=new URL(row.url);if(u.protocol!=='https:'||u.username||u.password)return [];return [{title:plain(row.title||u.hostname).slice(0,300),url:u.toString(),snippet:plain(row.content||'').slice(0,1000)}];}catch{return [];}});
  return {results,query,source:'SearXNG',observedAt:stamp(),evidenceKind:'observed',untrustedContent:true,engineErrors:Array.isArray(data.unresponsive_engines)?data.unresponsive_engines.map(row=>String(row[0]).slice(0,80)).slice(0,10):[]};
 }
 async function readGitHub(repository,path,accept){
  const url=`https://api.github.com/repos/${repository}${path}`;
  if(!env.GITHUB_TOKEN||!githubRepositories.has(repository))return readPublic(url,{accept});
  let response;
  try{response=await fetchImpl(url,{headers:{accept,authorization:`Bearer ${env.GITHUB_TOKEN}`},signal:AbortSignal.timeout(15000)});}catch{throw new Error('GitHub request is unavailable.');}
  if(!response.ok)throw new Error(`GitHub request failed (${response.status})`);
  const body=await response.text();
  if(body.length>1000000)throw new Error('GitHub response exceeds size limit');
  return {text:body,url,headers:Object.fromEntries(response.headers.entries())};
 }
 async function searchGitHubIssues(repository,query){
  const url=`https://api.github.com/search/issues?${new URLSearchParams({q:`repo:${repository} ${query}`,per_page:'10',sort:'updated',order:'desc'})}`;
  if(!env.GITHUB_TOKEN||!githubRepositories.has(repository))return (await readPublic(url,{accept:'application/vnd.github+json'})).text;
  let response;try{response=await fetchImpl(url,{headers:{accept:'application/vnd.github+json',authorization:`Bearer ${env.GITHUB_TOKEN}`},signal:AbortSignal.timeout(15000)});}catch{throw new Error('GitHub issue search is unavailable.');}
  if(!response.ok)throw new Error(`GitHub issue search failed (${response.status})`);
  const body=await response.text();if(body.length>1000000)throw new Error('GitHub issue search response exceeds size limit');return body;
 }
 async function slackChannel(channelId){
  chatEvidenceGuard(channelId,slackChannels,'Slack');
  if(!env.SLACK_BOT_TOKEN)throw new Error('Slack is not connected. Add a read-only bot token.');
  const endpoint=new URL('https://slack.com/api/conversations.history');endpoint.search=new URLSearchParams({channel:channelId,limit:'20'}).toString();
  const response=await fetchImpl(endpoint,{headers:{authorization:`Bearer ${env.SLACK_BOT_TOKEN}`,accept:'application/json'},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(`Slack request failed (${response.status})`);
  const data=await response.json();
  if(!data?.ok||!Array.isArray(data.messages)){const reason=typeof data?.error==='string'&&/^[a-z_]+$/i.test(data.error)?`: ${data.error}`:'';throw new Error(`Slack did not return readable channel messages${reason}.`);}
  return {channelId,results:data.messages.slice(0,20).map(message=>({id:String(message.ts||randomUUID()),title:'Slack channel message',summary:plain(message.text||'').slice(0,1000),mentionText:String(message.text||'').slice(0,4000),authorId:String(message.user||message.bot_id||''),threadId:String(message.thread_ts||message.ts||''),observedAt:message.ts?new Date(Number(message.ts)*1000).toISOString():stamp()})),source:`Slack channel ${channelId}`,observedAt:stamp(),evidenceKind:'observed',untrustedContent:true};
 }
 async function discordChannel(channelId){
  chatEvidenceGuard(channelId,discordChannels,'Discord');
  if(!env.DISCORD_BOT_TOKEN)throw new Error('Discord is not connected. Add a read-only bot token.');
  const endpoint=new URL(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`);endpoint.search=new URLSearchParams({limit:'20'}).toString();
  const response=await fetchImpl(endpoint,{headers:{authorization:`Bot ${env.DISCORD_BOT_TOKEN}`,accept:'application/json'},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(`Discord request failed (${response.status})`);
  const data=await response.json();
  if(!Array.isArray(data))throw new Error('Discord did not return readable channel messages.');
  return {channelId,results:data.slice(0,20).map(message=>({id:String(message.id||randomUUID()),title:`Discord message · ${new Date(message.timestamp||stamp()).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}`,summary:plain(message.content||'').slice(0,1000),mentionText:String(message.content||'').slice(0,4000),authorId:String(message.author?.id||''),mentionIds:Array.isArray(message.mentions)?message.mentions.map(item=>String(item.id||'')).filter(Boolean).slice(0,20):[],observedAt:message.timestamp||stamp()})),source:`Discord channel ${channelId}`,observedAt:stamp(),evidenceKind:'observed',untrustedContent:true};
 }
 const validRepository=repository=>/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository);
 const validPath=path=>typeof path==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$/.test(path)&&!path.includes('..')&&!path.includes('//');
 const validBranch=branch=>typeof branch==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch)&&!branch.includes('..')&&!branch.includes('//')&&!branch.includes('@{');
 const binaryExtension=/\.(?:7z|avi|bin|bmp|class|dll|docx?|eot|exe|gif|gz|ico|jar|jpeg|jpg|mov|mp3|mp4|otf|pdf|png|pptx?|rar|so|tar|ttf|wav|webm|webp|woff2?|xls[xm]?|zip)$/i;
 const textCandidate=path=>validPath(path)&&!binaryExtension.test(path);
 const decodeGitHubBlob=blob=>{
  if(!blob||blob.encoding!=='base64'||typeof blob.content!=='string')throw new Error('GitHub did not return a readable source blob.');
  const content=Buffer.from(blob.content.replace(/\s/g,''),'base64').toString('utf8');
  if(content.includes('\0'))throw new Error('GitHub returned binary data where text source was expected.');
  return content;
 };
 async function repositoryTree(repository,requestedRef){
  if(!validRepository(repository)||!githubRepositories.has(repository))throw new Error('GitHub repository evidence requires an allowlisted repository.');
  const ref=requestedRef===undefined||requestedRef===null?null:string(requestedRef,'ref',200);
  if(ref!==null&&!validBranch(ref)&&!/^[a-f0-9]{7,64}$/i.test(ref))throw new Error('Invalid GitHub ref.');
  let commitSha=ref;
  if(!commitSha||!/^[a-f0-9]{7,64}$/i.test(commitSha)){
   const metadata=JSON.parse((await readGitHub(repository,'','application/vnd.github+json')).text);
   const branch=commitSha||metadata?.default_branch;
   if(!validBranch(branch))throw new Error('GitHub did not return a valid default branch.');
   const branchRef=JSON.parse((await readGitHub(repository,`/git/ref/heads/${encodeURIComponent(branch)}`,'application/vnd.github+json')).text);
   commitSha=branchRef?.object?.sha;
  }
  if(typeof commitSha!=='string'||!/^[a-f0-9]{7,64}$/i.test(commitSha))throw new Error('GitHub did not return a commit identity.');
  const commit=JSON.parse((await readGitHub(repository,`/git/commits/${encodeURIComponent(commitSha)}`,'application/vnd.github+json')).text);
  const treeSha=commit?.tree?.sha;
  if(typeof treeSha!=='string'||!/^[a-f0-9]{7,64}$/i.test(treeSha))throw new Error('GitHub did not return a repository tree identity.');
  const tree=JSON.parse((await readGitHub(repository,`/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,'application/vnd.github+json')).text);
  if(!Array.isArray(tree?.tree))throw new Error('GitHub did not return a recursive repository tree.');
  if(tree.truncated)throw new Error('GitHub truncated this recursive tree. Narrow the repository or use a smaller repository before claiming a complete scan.');
  const files=tree.tree.filter(item=>item&&item.type==='blob'&&validPath(item.path)&&typeof item.sha==='string'&&/^[a-f0-9]{7,64}$/i.test(item.sha)).map(item=>({path:item.path,sha:item.sha,size:Number.isFinite(item.size)?Math.max(0,Number(item.size)):null}));
  return {repository,commitSha,treeSha,files};
 }
 const chunks=(values,size)=>Array.from({length:Math.ceil(values.length/size)},(_,index)=>values.slice(index*size,(index+1)*size));
 async function githubMentions(){
  if(!env.GITHUB_TOKEN||!githubRepositories.size)return [];
  const handle=String(env.GITHUB_MENTION_HANDLE||'mova').replace(/^@/,'').replace(/[^A-Za-z0-9-]/g,'').toLowerCase();
  if(!handle)return [];
  const events=[];
  for(const repository of githubRepositories){
   const endpoint=`https://api.github.com/repos/${repository}/issues/comments?per_page=30&sort=created&direction=desc`;
   let response;try{response=await fetchImpl(endpoint,{headers:{authorization:`Bearer ${env.GITHUB_TOKEN}`,accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000)});}catch{continue;}
   if(!response.ok)continue;
   const comments=await response.json();if(!Array.isArray(comments))continue;
   for(const comment of comments){
    const content=plain(comment.body||'').slice(0,4000);
    if(!new RegExp(`(^|\\s)@${handle}(?:\\[bot\\])?\\b`,'i').test(content))continue;
    const match=String(comment.issue_url||'').match(/\/issues\/(\d+)$/);
    if(!match)continue;
    events.push({eventId:`github:${repository}:${String(comment.id||'')}`,service:'GitHub',source:`GitHub ${repository} #${match[1]}`,repository,issueNumber:Number(match[1]),authorId:String(comment.user?.login||''),content,observedAt:comment.created_at||stamp()});
   }
  }
  return events;
 }
 async function githubIssues(repository,args){
  if(!validRepository(repository)||!githubRepositories.has(repository))throw new Error('GitHub issue evidence requires an allowlisted repository.');
  const issueNumber=args.issueNumber;
  if(issueNumber!==undefined&&(!Number.isInteger(issueNumber)||issueNumber<1))throw new Error('Invalid GitHub issue number.');
  const query=args.query===undefined?'':string(args.query,'issue search query',300);
  const state=args.state===undefined?'all':args.state;
  if(!['open','closed','all'].includes(state))throw new Error('Invalid GitHub issue state.');
  const path=issueNumber?`/issues/${issueNumber}`:`/issues?state=${state}&per_page=12&sort=updated&direction=desc`;
  const issueText=issueNumber||!query?(await readGitHub(repository,path,'application/vnd.github+json')).text:await searchGitHubIssues(repository,`${query} is:issue${state==='all'?'':` is:${state}`}`);
  const response=JSON.parse(issueText);
  const sourceRows=Array.isArray(response)?response:Array.isArray(response?.items)?response.items:[response];
  const issues=sourceRows.filter(issue=>issue&&typeof issue==='object'&&!issue.pull_request).slice(0,10);
  const results=[];
  for(const issue of issues){
   const number=Number(issue.number);if(!Number.isInteger(number)||number<1)continue;
   let comments=[];
   try{const thread=JSON.parse((await readGitHub(repository,`/issues/${number}/comments?per_page=12&sort=created&direction=asc`,'application/vnd.github+json')).text);comments=Array.isArray(thread)?thread.slice(-12).map(comment=>({author:String(comment.user?.login||'Unknown').slice(0,120),body:plain(comment.body||'').slice(0,900)})):[];}catch(error){if(!String(error.message).includes('(404)'))throw error;}
   const body=plain(issue.body||'').slice(0,1800);
   const thread=comments.map(comment=>`${comment.author}: ${comment.body}`).filter(Boolean).join('\n').slice(0,5000);
   results.push({id:`issue-${number}`,title:`GitHub issue #${number}: ${String(issue.title||'Untitled issue').slice(0,240)}`,summary:[`State: ${String(issue.state||'unknown')}.`,body?`Description: ${body}`:'',thread?`Discussion:\n${thread}`:''].filter(Boolean).join('\n'),url:typeof issue.html_url==='string'?issue.html_url:undefined,issueNumber:number,repository,state:String(issue.state||'unknown'),observedAt:issue.updated_at||issue.created_at||stamp()});
  }
  if(!results.length)results.push({id:'empty-issues',title:query?'GitHub issue search returned no matches':'GitHub issue listing returned no issues',summary:query?`No issues matched the repository-scoped search terms: ${query}.`:'The requested GitHub issue listing returned no issues.',observedAt:stamp()});
  return {repository,query:query||undefined,results,source:query?`https://github.com/${repository}/issues?q=${encodeURIComponent(query)}`:`https://github.com/${repository}/issues`,observedAt:stamp(),evidenceKind:'observed',untrustedContent:true};
 }
 async function listMentions(){
  const events=[];
  const slackBot=String(env.SLACK_BOT_USER_ID||'').trim();
  if(env.SLACK_BOT_TOKEN&&slackChannels.size&&graphContentAllowed)for(const channelId of slackChannels){
   try{const feed=await slackChannel(channelId);for(const item of feed.results){const tagged=/(^|\s)@mova\b/i.test(item.summary)||(slackBot&&item.mentionText?.includes(`<@${slackBot}>`));if(tagged)events.push({eventId:`slack:${channelId}:${item.id}`,service:'Slack',source:`Slack channel ${channelId}`,channelId,authorId:item.authorId||'',content:item.mentionText||item.summary,observedAt:item.observedAt});}}catch{}
  }
  const discordBot=String(env.DISCORD_BOT_USER_ID||'').trim();
  if(env.DISCORD_BOT_TOKEN&&discordChannels.size&&graphContentAllowed)for(const channelId of discordChannels){
   try{const feed=await discordChannel(channelId);for(const item of feed.results){const tagged=/(^|\s)@mova\b/i.test(item.summary)||(discordBot&&item.mentionIds?.includes(discordBot));if(tagged)events.push({eventId:`discord:${channelId}:${item.id}`,service:'Discord',source:`Discord channel ${channelId}`,channelId,authorId:item.authorId||'',content:item.mentionText||item.summary,observedAt:item.observedAt});}}catch{}
  }
  return [...events,...await githubMentions()].filter(event=>event.eventId&&Number.isFinite(Date.parse(event.observedAt))).sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt));
 }
 async function listCustomerReports(){
  if(!env.DISCORD_BOT_TOKEN||!discordChannels.size||!graphContentAllowed)return [];
  const reports=[];
  for(const channelId of discordChannels){
   try{const feed=await discordChannel(channelId);for(const item of feed.results){if(!/(^|\s)#customer-issue\b/i.test(item.summary))continue;reports.push({eventId:`discord:${channelId}:${item.id}`,id:`discord:${channelId}:${item.id}`,service:'Discord',source:`Discord channel ${channelId}`,channelId,authorId:item.authorId||'',content:item.summary,observedAt:item.observedAt});}}catch{}
  }
  return reports.filter(event=>Number.isFinite(Date.parse(event.observedAt))).sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt));
 }
 function createProposal(name,args){
  if(name==='propose_github_pr_comment'){
   const repository=string(args.repository,'repository',200);if(!validRepository(repository)||!githubRepositories.has(repository)||!env.GITHUB_TOKEN)throw new Error('GitHub writes require a token and an allowlisted repository.');
   if(!Number.isInteger(args.pullNumber)||args.pullNumber<1)throw new Error('Invalid pull request number');
   return {proposal:{id:randomUUID(),service:'github',operation:'comment_on_pull_request',repository,pullNumber:args.pullNumber,body:string(args.body,'body',5000),status:'PENDING_APPROVAL',createdAt:stamp()}};
  }
  if(name==='propose_github_issue_comment'){
   const repository=string(args.repository,'repository',200);if(!validRepository(repository)||!githubRepositories.has(repository)||!env.GITHUB_TOKEN)throw new Error('GitHub writes require a token and an allowlisted repository.');
   if(!Number.isInteger(args.issueNumber)||args.issueNumber<1)throw new Error('Invalid issue or pull request number');
   return {proposal:{id:randomUUID(),service:'github',operation:'comment_on_issue',repository,issueNumber:args.issueNumber,body:string(args.body,'body',5000),status:'PENDING_APPROVAL',createdAt:stamp()}};
  }
  if(name==='propose_github_issue'){
   const repository=string(args.repository,'repository',200);if(!validRepository(repository)||!githubRepositories.has(repository)||!env.GITHUB_TOKEN)throw new Error('GitHub writes require a token and an allowlisted repository.');
   const labels=args.labels===undefined?[]:args.labels;
   if(!Array.isArray(labels)||labels.length>8||labels.some(label=>typeof label!=='string'||!label.trim()||label.length>80))throw new Error('Invalid GitHub issue labels.');
   return {proposal:{id:randomUUID(),service:'github',operation:'create_issue',repository,title:string(args.title,'title',240),body:string(args.body,'body',10000),labels:labels.map(label=>label.trim()),status:'PENDING_APPROVAL',createdAt:stamp()}};
  }
  if(name==='propose_github_commit'){
   const repository=string(args.repository,'repository',200),branch=string(args.branch,'branch',100),message=string(args.message,'message',500),files=args.files;
   if(!validRepository(repository)||!githubRepositories.has(repository)||!env.GITHUB_TOKEN)throw new Error('GitHub writes require a token and an allowlisted repository.');
   if(!validBranch(branch))throw new Error('Invalid GitHub branch.');
   if(!Array.isArray(files)||files.length<1||files.length>10)throw new Error('A commit needs between 1 and 10 files.');
   let bytes=0;const normalized=files.map(file=>{if(!file||typeof file!=='object'||!validPath(file.path)||typeof file.content!=='string'||file.content.length>50000)throw new Error('Invalid commit file.');bytes+=Buffer.byteLength(file.content,'utf8');return {path:file.path,content:file.content};});
   if(bytes>200000||new Set(normalized.map(file=>file.path)).size!==normalized.length)throw new Error('Commit files must be unique and no larger than 200 KB in total.');
   return {proposal:{id:randomUUID(),service:'github',operation:'create_commit',repository,branch,message,files:normalized,status:'PENDING_APPROVAL',createdAt:stamp()}};
  }
  const service=name==='propose_slack_message'?'slack':'discord';const channelId=string(args.channelId,'channelId',100);const channels=service==='slack'?slackChannels:discordChannels;
  chatEvidenceGuard(channelId,channels,service==='slack'?'Slack':'Discord');
  if(service==='slack'?!env.SLACK_BOT_TOKEN:!env.DISCORD_BOT_TOKEN)throw new Error(`${service==='slack'?'Slack':'Discord'} is not connected.`);
  return {proposal:{id:randomUUID(),service,operation:'post_channel_message',channelId,text:string(args.text,'text',5000),status:'PENDING_APPROVAL',createdAt:stamp()}};
 }
 async function executeProposal(proposal){
  if(!proposal||typeof proposal!=='object'||proposal.status!=='PENDING_APPROVAL'||typeof proposal.id!=='string')throw new Error('Invalid pending action proposal.');
  let endpoint,headers,body,source;
  if(proposal.service==='github'&&proposal.operation==='comment_on_pull_request'){
   if(!validRepository(proposal.repository)||!githubRepositories.has(proposal.repository)||!env.GITHUB_TOKEN||!Number.isInteger(proposal.pullNumber)||typeof proposal.body!=='string')throw new Error('GitHub proposal is no longer authorized.');
   endpoint=`https://api.github.com/repos/${proposal.repository}/issues/${proposal.pullNumber}/comments`;headers={authorization:`Bearer ${env.GITHUB_TOKEN}`,accept:'application/vnd.github+json','content-type':'application/json'};body={body:proposal.body};source='GitHub pull request comment';
  }else if(proposal.service==='github'&&proposal.operation==='comment_on_issue'){
   if(!validRepository(proposal.repository)||!githubRepositories.has(proposal.repository)||!env.GITHUB_TOKEN||!Number.isInteger(proposal.issueNumber)||typeof proposal.body!=='string')throw new Error('GitHub proposal is no longer authorized.');
   endpoint=`https://api.github.com/repos/${proposal.repository}/issues/${proposal.issueNumber}/comments`;headers={authorization:`Bearer ${env.GITHUB_TOKEN}`,accept:'application/vnd.github+json','content-type':'application/json'};body={body:proposal.body};source='GitHub issue or pull request discussion reply';
  }else if(proposal.service==='github'&&proposal.operation==='create_issue'){
   if(!validRepository(proposal.repository)||!githubRepositories.has(proposal.repository)||!env.GITHUB_TOKEN||typeof proposal.title!=='string'||typeof proposal.body!=='string'||!Array.isArray(proposal.labels))throw new Error('GitHub proposal is no longer authorized.');
   endpoint=`https://api.github.com/repos/${proposal.repository}/issues`;headers={authorization:`Bearer ${env.GITHUB_TOKEN}`,accept:'application/vnd.github+json','content-type':'application/json'};body={title:proposal.title,body:proposal.body,labels:proposal.labels};source='GitHub issue';
  }else if(proposal.service==='github'&&proposal.operation==='create_commit'){
   if(!validRepository(proposal.repository)||!githubRepositories.has(proposal.repository)||!env.GITHUB_TOKEN||!validBranch(proposal.branch)||typeof proposal.message!=='string'||!Array.isArray(proposal.files))throw new Error('GitHub commit proposal is no longer authorized.');
   const validate=createProposal('propose_github_commit',{repository:proposal.repository,branch:proposal.branch,message:proposal.message,files:proposal.files}).proposal;
   const request=async(path,{method='GET',body:payload}={})=>{
    let response;try{response=await fetchImpl(`https://api.github.com/repos/${validate.repository}${path}`,{method,headers:{authorization:`Bearer ${env.GITHUB_TOKEN}`,accept:'application/vnd.github+json','content-type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)}),signal:AbortSignal.timeout(15000)});}catch{throw new Error('GitHub commit request failed or timed out.');}
    if(!response.ok)throw new Error(`GitHub commit request failed (${response.status}).`);
    return response.json();
   };
   const encodedBranch=encodeURIComponent(validate.branch);
   const ref=await request(`/git/ref/heads/${encodedBranch}`);const headSha=ref?.object?.sha;
   if(typeof headSha!=='string'||!headSha)throw new Error('GitHub did not return the target branch head.');
   const head=await request(`/git/commits/${encodeURIComponent(headSha)}`);const baseTree=head?.tree?.sha;
   if(typeof baseTree!=='string'||!baseTree)throw new Error('GitHub did not return the target branch tree.');
   const tree=[];for(const file of validate.files){const blob=await request('/git/blobs',{method:'POST',body:{content:file.content,encoding:'utf-8'}});if(typeof blob?.sha!=='string'||!blob.sha)throw new Error('GitHub did not return a blob identity.');tree.push({path:file.path,mode:'100644',type:'blob',sha:blob.sha});}
   const createdTree=await request('/git/trees',{method:'POST',body:{base_tree:baseTree,tree}});if(typeof createdTree?.sha!=='string'||!createdTree.sha)throw new Error('GitHub did not return a tree identity.');
   const commit=await request('/git/commits',{method:'POST',body:{message:validate.message,tree:createdTree.sha,parents:[headSha]}});if(typeof commit?.sha!=='string'||!commit.sha)throw new Error('GitHub did not return a commit identity.');
   const updated=await request(`/git/refs/heads/${encodedBranch}`,{method:'PATCH',body:{sha:commit.sha,force:false}});if(updated?.object?.sha!==commit.sha)throw new Error('GitHub did not confirm the branch update.');
   return {status:'VERIFIED',source:`GitHub commit on ${validate.branch}`,observedAt:stamp(),proposalId:proposal.id,remoteId:commit.sha,url:typeof commit.html_url==='string'?commit.html_url:`https://github.com/${validate.repository}/commit/${commit.sha}`};
  }else if(proposal.service==='slack'&&proposal.operation==='post_channel_message'){
   chatEvidenceGuard(proposal.channelId,slackChannels,'Slack');if(!env.SLACK_BOT_TOKEN||typeof proposal.text!=='string')throw new Error('Slack proposal is no longer authorized.');
   endpoint='https://slack.com/api/chat.postMessage';headers={authorization:`Bearer ${env.SLACK_BOT_TOKEN}`,accept:'application/json','content-type':'application/json'};body={channel:proposal.channelId,text:proposal.text};source=`Slack channel ${proposal.channelId}`;
  }else if(proposal.service==='discord'&&proposal.operation==='post_channel_message'){
   chatEvidenceGuard(proposal.channelId,discordChannels,'Discord');if(!env.DISCORD_BOT_TOKEN||typeof proposal.text!=='string')throw new Error('Discord proposal is no longer authorized.');
   endpoint=`https://discord.com/api/v10/channels/${encodeURIComponent(proposal.channelId)}/messages`;headers={authorization:`Bot ${env.DISCORD_BOT_TOKEN}`,accept:'application/json','content-type':'application/json'};body={content:proposal.text};source=`Discord channel ${proposal.channelId}`;
  }else throw new Error('Unsupported action proposal.');
  let response;try{response=await fetchImpl(endpoint,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});}catch{throw new Error(`${proposal.service} action request failed or timed out.`);}
  if(!response.ok)throw new Error(`${proposal.service} action failed (${response.status}).`);
  const result=await response.json();if(proposal.service==='slack'&&!result?.ok)throw new Error('Slack rejected the approved action.');if(proposal.operation==='create_issue'&&(!Number.isInteger(result?.id)||typeof result?.html_url!=='string'||!result.html_url.startsWith('https://')))throw new Error('GitHub did not return a verifiable issue receipt.');
  return {status:'VERIFIED',source,observedAt:stamp(),proposalId:proposal.id,remoteId:String(proposal.operation==='create_issue'?result.number||result.id:result.id||result.ts||result.html_url||''),url:result.html_url||null};
 }
 async function artifact(args,context){
  const title=string(args.title,'title',200);string(args.content,'content',100000);const content=args.content;
  if(!Array.isArray(args.sourceIds)||args.sourceIds.length>100||args.sourceIds.some(id=>typeof id!=='string'||!id||id.length>200))throw new Error('Invalid sourceIds');
  const sourceIds=[...new Set(args.sourceIds)];
  const idempotencyKey=context.idempotencyKey||args.idempotencyKey||null;
  if(idempotencyKey)string(idempotencyKey,'idempotencyKey',200);
  const digest=idempotencyKey?hash(`${context.missionId||''}\0${idempotencyKey}`):null;
  const id=digest?`${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`:randomUUID();
  const contentHash=hash(JSON.stringify({title,content,sourceIds}));
  const record={id,title,content,sourceIds,contentHash,idempotencyKey,missionId:context.missionId||null,stepId:context.stepId||null,verifiedAt:stamp(),source:'MOVA local artifact store',observedAt:stamp(),evidenceKind:'verified',status:'VERIFIED'};
  await mkdir(artifactDir,{recursive:true});const path=join(artifactDir,`${id}.json`);
  const temporary=join(artifactDir,`${id}.${randomUUID()}.tmp`);
  await writeFile(temporary,JSON.stringify(record,null,2),{encoding:'utf8',flag:'wx',mode:0o600});
  try{await link(temporary,path);}catch(error){if(error.code!=='EEXIST')throw error;}finally{await unlink(temporary);}
  const stored=JSON.parse(await readFile(path,'utf8'));
  if(stored.contentHash!==contentHash||hash(JSON.stringify({title:stored.title,content:stored.content,sourceIds:stored.sourceIds}))!==contentHash)throw new Error('Artifact retry key already contains different content');
  return stored;
 }
 return {
  list:()=>structuredClone(definitions.filter(def=>def.name==='analyze_github_blast_radius'?Boolean(operationsGraph?.repositoryBlastRadius):def.name==='read_slack_channel'||def.name==='propose_slack_message'?Boolean(env.SLACK_BOT_TOKEN&&slackChannels.size&&graphContentAllowed):def.name==='read_discord_channel'||def.name==='propose_discord_message'?Boolean(env.DISCORD_BOT_TOKEN&&discordChannels.size&&graphContentAllowed):['propose_github_pr_comment','propose_github_issue_comment','propose_github_issue','propose_github_commit'].includes(def.name)?Boolean(env.GITHUB_TOKEN&&githubRepositories.size):true)),
  async call(name,args={},context={}){
   const def=definitions.find(item=>item.name===name);if(!def)throw new Error('Unknown work tool');
   if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!Object.hasOwn(def.inputSchema.properties,key)))throw new Error('Invalid tool argument');
   for(const key of def.inputSchema.required)if(args[key]===undefined)throw new Error(`Missing ${key}`);
   if(name==='web_search')return search(string(args.query,'query',500));
   if(name==='read_web_page'){
    const result=await readPublic(args.url);const type=String(result.headers['content-type']||'');
    if(!/text\/|application\/(json|xhtml\+xml)/i.test(type))throw new Error('Unsupported webpage content type');
    const html=/html/i.test(type);const text=html?plain(result.text):result.text;
    return {url:result.url,title:html?plain(result.text.match(/<title\b[^>]*>([^]*?)<\/title>/i)?.[1]||'').slice(0,300):'',text:text.slice(0,18000),truncated:text.length>18000,source:result.url,observedAt:stamp(),evidenceKind:'observed',untrustedContent:true};
   }
   if(name==='read_github_repository'){
    const repository=string(args.repository,'repository',200);
    if(!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository))throw new Error('Invalid repository; use owner/repo');
    const base=`https://api.github.com/repos/${repository}`;
    const metadata=JSON.parse((await readGitHub(repository,'','application/vnd.github+json')).text);
    let files=[];
    try{files=JSON.parse((await readGitHub(repository,'/contents','application/vnd.github+json')).text);}catch(error){if(!String(error.message).includes('(404)'))throw error;}
    let readme='',readmeStatus='available';
    try{readme=(await readGitHub(repository,'/readme','application/vnd.github.raw+json')).text.slice(0,16000);}catch(error){if(error.message.includes('(404)'))readmeStatus='not_found';else throw error;}
    return {repository:metadata.full_name,url:metadata.html_url,description:metadata.description,defaultBranch:metadata.default_branch,stars:metadata.stargazers_count,updatedAt:metadata.updated_at,files:Array.isArray(files)?files.slice(0,100).map(file=>({name:file.name,type:file.type,path:file.path})):[],readme,readmeStatus,source:base,observedAt:stamp(),evidenceKind:'observed',untrustedContent:true};
   }
   if(name==='read_github_repository_tree'){
    const repository=string(args.repository,'repository',200);const tree=await repositoryTree(repository,args.ref);
     if(tree.files.length>MAX_TREE_EVIDENCE_FILES)throw new Error(`Repository tree has ${tree.files.length} files, above the ${MAX_TREE_EVIDENCE_FILES}-file evidence limit and cannot return completely. Use a smaller repository or a targeted source path.`);
     const results=chunks(tree.files,150).map((group,index)=>({id:`github-tree:${repository}:${tree.commitSha}:${index}`,title:`${repository} repository tree ${index+1}`,summary:group.map(file=>`${file.path}${file.size===null?'':` (${file.size} bytes)`}`).join('\n'),observedAt:stamp()}));
    return {repository,commitSha:tree.commitSha,treeSha:tree.treeSha,fileCount:tree.files.length,complete:true,results,source:`https://api.github.com/repos/${repository}/git/trees/${tree.treeSha}`,observedAt:stamp(),evidenceKind:'observed',untrustedContent:true};
   }
   if(name==='read_github_repository_snapshot'){
    const repository=string(args.repository,'repository',200);const tree=await repositoryTree(repository,args.ref);
    const textFiles=tree.files.filter(file=>textCandidate(file.path));const skippedBinaryFiles=tree.files.length-textFiles.length;
    const advertisedBytes=textFiles.reduce((total,file)=>total+(file.size||0),0);
    if(textFiles.length>maximumSnapshotFiles)throw new Error(`Repository snapshot has ${textFiles.length} textual files, above the configured ${maximumSnapshotFiles}-file safety limit. Use the repository tree and targeted code reads, or raise MOVA_GITHUB_SNAPSHOT_MAX_FILES.`);
    if(advertisedBytes>maximumSnapshotBytes)throw new Error(`Repository snapshot has ${advertisedBytes} textual bytes, above the configured ${maximumSnapshotBytes}-byte safety limit. Use targeted code reads, or raise MOVA_GITHUB_SNAPSHOT_MAX_BYTES.`);
     const results=[],indexedFiles=[];let totalBytes=0;
    for(const file of textFiles){
      const blob=JSON.parse((await readGitHub(repository,`/git/blobs/${encodeURIComponent(file.sha)}`,'application/vnd.github+json')).text);
      const content=decodeGitHubBlob(blob);totalBytes+=Buffer.byteLength(content,'utf8');
      if(totalBytes>maximumSnapshotBytes)throw new Error(`Repository snapshot exceeded the configured ${maximumSnapshotBytes}-byte safety limit while reading ${file.path}.`);
      results.push({id:`github-snapshot:${repository}:${tree.commitSha}:${file.path}`,title:file.path,summary:content,url:`https://github.com/${repository}/blob/${tree.commitSha}/${file.path.split('/').map(encodeURIComponent).join('/')}`,observedAt:stamp()});
       indexedFiles.push({path:file.path,sha:file.sha,content});
    }
     if(operationsGraph?.indexRepositorySnapshot)await operationsGraph.indexRepositorySnapshot({repository,commitSha:tree.commitSha,files:indexedFiles});
    return {repository,commitSha:tree.commitSha,treeSha:tree.treeSha,complete:true,scannedFiles:results.length,skippedBinaryFiles,totalBytes,results,source:`https://api.github.com/repos/${repository}/git/trees/${tree.treeSha}`,observedAt:stamp(),evidenceKind:'observed',untrustedContent:true};
   }
    if(name==='analyze_github_blast_radius'){
     const repository=string(args.repository,'repository',200),path=string(args.path,'path',500);
     if(!validRepository(repository)||!githubRepositories.has(repository)||!validPath(path))throw new Error('FalkorDB repository blast radius requires an allowlisted repository and valid source path.');
     if(!operationsGraph?.repositoryBlastRadius)throw new Error('FalkorDB repository dependency graph is unavailable.');
     return operationsGraph.repositoryBlastRadius({repository,path});
    }
   if(name==='read_github_code'){
    const repository=string(args.repository,'repository',200),path=string(args.path,'path',500),ref=args.ref===undefined?null:string(args.ref,'ref',200);
    if(!validRepository(repository)||!githubRepositories.has(repository))throw new Error('GitHub code evidence requires an allowlisted repository.');
    if(!validPath(path))throw new Error('Invalid GitHub file path.');
    if(ref!==null&&!validBranch(ref)&&!/^[a-f0-9]{7,64}$/i.test(ref))throw new Error('Invalid GitHub ref.');
    const response=JSON.parse((await readGitHub(repository,`/contents/${path.split('/').map(encodeURIComponent).join('/')}?${new URLSearchParams(ref?{ref}:{}).toString()}`,'application/vnd.github+json')).text);
    if(!response||response.type!=='file'||response.encoding!=='base64'||typeof response.content!=='string')throw new Error('GitHub did not return a readable source file.');
    const content=Buffer.from(response.content.replace(/\s/g,''),'base64').toString('utf8');if(Buffer.byteLength(content,'utf8')>100000)throw new Error('GitHub source file exceeds the 100 KB evidence limit.');
    return {repository,path,ref:ref||null,results:[{id:`github-code:${repository}:${path}:${ref||'default'}`,title:`${repository}/${path}`,summary:content,url:typeof response.html_url==='string'?response.html_url:undefined,observedAt:stamp()}],source:`https://api.github.com/repos/${repository}/contents/${path}`,observedAt:stamp(),evidenceKind:'observed',untrustedContent:true};
   }
   if(name==='read_github_commits'){
    const repository=string(args.repository,'repository',200);
    if(!validRepository(repository))throw new Error('Invalid repository; use owner/repo');
    const base=`https://api.github.com/repos/${repository}`;
    let commits;try{commits=JSON.parse((await readGitHub(repository,'/commits?per_page=10','application/vnd.github+json')).text);}catch(error){if(String(error.message).includes('(409)'))commits=[];else throw error;}
    if(!Array.isArray(commits))throw new Error('GitHub did not return a commit list.');
    return {repository,results:commits.slice(0,10).map(commit=>({id:String(commit.sha||randomUUID()),title:String(commit.commit?.message||'GitHub commit').split('\n')[0].slice(0,300),summary:`${String(commit.commit?.author?.name||'Unknown author').slice(0,160)} · ${String(commit.commit?.author?.date||'Unknown date').slice(0,80)}`,url:typeof commit.html_url==='string'?commit.html_url:undefined,observedAt:commit.commit?.author?.date||stamp()})),source:`${base}/commits`,observedAt:stamp(),evidenceKind:'observed',untrustedContent:true};
   }
   if(name==='read_github_issues')return githubIssues(string(args.repository,'repository',200),args);
   if(name==='read_slack_channel')return slackChannel(string(args.channelId,'channelId',100));
   if(name==='read_discord_channel')return discordChannel(string(args.channelId,'channelId',100));
   if(name.startsWith('propose_'))return createProposal(name,args);
   if(name==='save_artifact')return artifact(args,context);
   if(name==='list_artifacts'){
    await mkdir(artifactDir,{recursive:true});const names=(await readdir(artifactDir)).filter(file=>/^[0-9a-f-]{36}\.json$/.test(file)).sort().slice(-100);
    const artifacts=[];for(const name of names){const record=JSON.parse(await readFile(join(artifactDir,name),'utf8'));if(hash(JSON.stringify({title:record.title,content:record.content,sourceIds:record.sourceIds}))!==record.contentHash)throw new Error('Artifact integrity check failed');artifacts.push(record);}
    return {artifacts,source:'MOVA local artifact store',observedAt:stamp(),evidenceKind:'verified'};
   }
   if(!adapters.getCalendarEvents)throw new Error('Calendar adapter is not connected');
   const result=await adapters.getCalendarEvents();return {...result,source:result.source||'Google Calendar',observedAt:result.observedAt||stamp(),evidenceKind:'observed'};
  }, executeProposal, listMentions, listCustomerReports,
 };
}
