/** Browser consumer fixture: real HTTP transport, no model or iframe bypass. */
export const builderUIFixture = String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {WebBuilder, Conversation} from '@philvernon/web-project-runtime/client';
import {createHttpBuilderTransport} from '@philvernon/web-project-runtime/headless';
import '@philvernon/web-project-runtime/styles.css';
const probes=window.probes={events:[],submissions:[],signals:[],stops:0,resets:0,blobs:new Set(),controlled:[]};
const make=URL.createObjectURL.bind(URL), revoke=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=value=>{const url=make(value);probes.blobs.add(url);return url;};
URL.revokeObjectURL=url=>{probes.blobs.delete(url);revoke(url);};
const http=createHttpBuilderTransport({endpoint:'/builder'});
const transport={
  async *submit(command,signal){
    probes.submissions.push(command); probes.signals.push(signal);
    for await(const event of http.submit(command,signal)) {probes.events.push(event);yield event;}
  },
  stop(id,signal){probes.stops++; return http.stop(id,signal);},
  reset(id,signal){probes.resets++; return http.reset(id,signal);}
};
const artifactPath=id=>'/artifacts/'+id;
const root=createRoot(document.getElementById('root'));
window.dispose=()=>root.unmount();
function Controlled() {
  const [state,setState]=React.useState({exchanges:[],waiting:false,canSubmit:true});
  window.control=setState;
  return <Conversation {...state} heading="Controlled conversation" assistantLabel="Builder" introduction="Describe a web project."
    submitMessage={message=>{probes.controlled.push(message);}}
    stopWaiting={()=>{probes.stops++;setState(s=>({...s,waiting:false,canSubmit:true}));}}
    starters={[{category:'Start',text:'A synthetic public prompt'}]}
    renderResult={id=><p data-result={id}>Trusted result for {id}</p>}/>;
}
function App(){return location.pathname==='/controlled' ? <Controlled/> : <WebBuilder transport={transport} artifactPath={artifactPath}
  heading="Build a web project" assistantLabel="Builder" introduction="Synthetic test endpoint. No real inference."
  starters={[{category:'Start',text:'Build the first synthetic project'}]}/>;}
window.rerender=()=>root.render(<React.StrictMode><App/></React.StrictMode>);
window.rerender();
`;
