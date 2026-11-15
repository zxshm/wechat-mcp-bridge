let signals=0;
process.on('SIGTERM',()=>{signals++;setTimeout(()=>process.exit(signals===1?0:91),100);});
process.stdout.write(JSON.stringify({level:'info',message:'Registered tunnel connection',connIndex:0})+'\n');
setInterval(()=>{},1000);
