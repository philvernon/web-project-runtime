/** Runs inside an external packed installation, without React, sources or repository siblings. */
export const packedBuilderProof = String.raw`
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createProvider} from '@earendil-works/pi-ai';
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {createWebProjectRuntime} from '@philvernon/web-project-runtime/server';
import {createPiGateway, createBuilderService, createGenerationTool, handleBuilderRequest} from '@philvernon/web-project-runtime/pi';
import {Type} from 'typebox';
import {createWebBuilderController, createHttpBuilderTransport} from '@philvernon/web-project-runtime/headless';
let count=0;
const fixture=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw); assert.equal(req.headers.authorization,undefined);
  const index=count++;
  const conversation=index<2;
  assert.equal(body.max_completion_tokens,conversation?2048:8192);
  assert(!JSON.stringify(body).includes('host-only-routing'));
  if(conversation) assert.deepEqual(body.tools.map(tool=>tool.function.name),['public_lookup','build_public']);
  if(index===1) assert(JSON.stringify(body.messages).includes('Public value: 42'));
  if(index===2) assert(JSON.stringify(body.messages).includes('palette: blue'));
  const project={title:'Packed synthetic',entry:'main.js',files:[{path:'main.js',code:'document.body.textContent="Packed synthetic";'}],dependencies:[],assets:[]};
  const delta=conversation?{tool_calls:[{index:0,id:'call_packed_'+index,type:'function',function:{name:index===0?'public_lookup':'build_public',arguments:JSON.stringify(index===0?{dataset:'public'}:{brief:'Synthetic public interaction'})}}]}:{content:JSON.stringify(project)};
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
  let lookedUp=false;
  session=createBuilderService({runtime,gateway,
    toolSettings:{palette:'blue',internalRoute:'host-only-routing'},
    toolLimits:{rounds:3,batchCalls:2,totalCalls:2},
    tools:context=>({tools:[{
      name:'public_lookup',label:'Public lookup',description:'Synthetic public data',
      parameters:Type.Object({dataset:Type.Literal('public')},{additionalProperties:false}),
      execute:async()=>{lookedUp=true;return {content:[{type:'text',text:'Public value: 42'}],details:undefined};},
    },createGenerationTool(context,{
      name:'build_public',label:'Build public project',description:'Build with a public palette',
      parameters:Type.Object({brief:Type.String()},{additionalProperties:false}),
      prompt:args=>{assert(lookedUp);return args.brief+'; palette: '+context.settings.palette;},
      instructions:'Configured packed generation guidance',
    })],validateCall:(name)=>{if(name==='build_public')assert(lookedUp);}}),
  }).createSession();
  const origin='https://packed.test';
  const transport=createHttpBuilderTransport({origin,endpoint:'/builder',fetch:async(input,init)=>{
    const request=new Request(String(input),init);request.headers.set('origin',origin);
    return handleBuilderRequest(request,{session,exactOrigin:origin,path:'/builder'});
  }});
  controller=createWebBuilderController({transport});
  await controller.submit('Synthetic public request');
  const exchange=controller.getSnapshot().exchanges[0];
  assert.equal(exchange.status,'completed');assert.equal(exchange.artifacts.length,1);assert.equal(count,3);
  assert(runtime.getArtifact(exchange.artifacts[0].id).includes('script-src'));
  await assert.rejects(import('@philvernon/web-project-runtime/dist/pi/tools.js'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
} finally {
  await controller?.dispose();await session?.dispose();
  fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));
}
`;
