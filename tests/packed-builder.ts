/** Runs inside an external packed installation, without React, sources or repository siblings. */
export const packedBuilderProof = String.raw`
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createProvider} from '@earendil-works/pi-ai';
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {createWebProjectRuntime} from '@philvernon/web-project-runtime/server';
import {createPiGateway, createBuilderService, handleBuilderRequest} from '@philvernon/web-project-runtime/pi';
import {createWebBuilderController, createHttpBuilderTransport} from '@philvernon/web-project-runtime/headless';
let count=0;
const fixture=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw); assert.equal(req.headers.authorization,undefined);
  const conversation=count++===0;
  assert.equal(body.max_completion_tokens,conversation?2048:8192);
  const project={title:'Packed synthetic',entry:'main.js',files:[{path:'main.js',code:'document.body.textContent="Packed synthetic";'}],dependencies:[],assets:[]};
  const delta=conversation?{tool_calls:[{index:0,id:'call_packed',type:'function',function:{name:'generate_project',arguments:JSON.stringify({prompt:'Synthetic public interaction'})}}]}:{content:JSON.stringify(project)};
  const frame=(delta,finish_reason=null)=>({id:'synthetic',object:'chat.completion.chunk',created:1,model:'synthetic',choices:[{index:0,delta,finish_reason}]});
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const chunk of [frame({role:'assistant'}),frame(delta),frame({},conversation?'tool_calls':'stop'),{id:'synthetic',object:'chat.completion.chunk',choices:[],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}}])res.write('data: '+JSON.stringify(chunk)+'\n\n');
  res.end('data: [DONE]\n\n');
});
fixture.listen(0,'127.0.0.1');await once(fixture,'listening');
let session,controller;
try {
  const address=fixture.address();
  const model={id:'synthetic',name:'Synthetic',provider:'fixture',api:'openai-completions',baseUrl:'http://127.0.0.1:'+address.port+'/v1',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:8192};
  const provider=createProvider({id:'fixture',models:[model],auth:{apiKey:{name:'Fixture',resolve:async()=>({auth:{}})}},api:openAICompletionsApi()});
  const gateway=createPiGateway({provider,modelId:'synthetic',auth:{type:'local'}});
  const runtime=createWebProjectRuntime({dependencies:[],mountId:'project',artifactPath:id=>'/artifacts/'+id});
  session=createBuilderService({runtime,gateway}).createSession();
  const origin='https://packed.test';
  const transport=createHttpBuilderTransport({origin,endpoint:'/builder',fetch:async(input,init)=>{
    const request=new Request(String(input),init);request.headers.set('origin',origin);
    return handleBuilderRequest(request,{session,exactOrigin:origin,path:'/builder'});
  }});
  controller=createWebBuilderController({transport});
  await controller.submit('Synthetic public request');
  const exchange=controller.getSnapshot().exchanges[0];
  assert.equal(exchange.status,'completed');assert.equal(exchange.artifacts.length,1);assert.equal(count,2);
  assert(runtime.getArtifact(exchange.artifacts[0].id).includes('script-src'));
} finally {
  await controller?.dispose();await session?.dispose();
  fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));
}
`;
