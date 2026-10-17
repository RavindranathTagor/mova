const values=value=>String(value||'').split(',').map(item=>item.trim()).filter(Boolean);

export function createIncidentRouting({env=process.env}={}){
  const channels=new Set(values(env.DISCORD_ALLOWED_CHANNEL_IDS));
  const repositories=values(env.GITHUB_ALLOWED_REPOSITORIES);
  const explicit=String(env.CUSTOMER_ISSUE_REPOSITORY||'').trim();
  const repository=explicit||repositories[0]||'';
  if(!repository||!repositories.includes(repository))throw new Error('Customer issue routing requires an allowlisted GitHub repository.');
  return {
    resolve(event){
      if(!channels.has(event?.channelId))throw new Error('Customer report channel is not allowlisted.');
      return {channelId:event.channelId,repository,source:'configured'};
    },
    buildRequest(event){
      const binding=this.resolve(event);
      return {binding,text:`Investigate this customer report using the configured incident route. Discord channel ${binding.channelId}; GitHub repository ${binding.repository}. Report: ${String(event.content||'').slice(0,1800)}`};
    },
  };
}
