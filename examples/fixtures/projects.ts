import type { GeneratedProject } from "@philvernon/web-project-runtime/server";

/** Test-only synthetic model outputs, served through the Pi HTTP fixture.
 * Never imported by either runnable example; not an inference fallback. */
export function syntheticProject(
  domain: "experiences" | "charts",
  turn: number,
): GeneratedProject {
  const title = `${domain === "experiences" ? "Target game" : "Delivery chart"} — synthetic revision ${turn}`;
  const setup = `const root=document.getElementById('project');
    root.style.cssText='box-sizing:border-box;padding:16px;font:16px system-ui;max-width:100%;height:100%;overflow:auto;color:#172b40;background:#fff';
    const title=document.createElement('h1');title.textContent=${JSON.stringify(title)};title.style.fontSize='20px';root.append(title);`;
  const game = `
    let score=0;
    const readout=document.createElement('p');readout.setAttribute('role','status');
    const paint=()=>readout.textContent='Score: '+score;paint();root.append(readout);
    const hint=document.createElement('p');hint.textContent='Use Tab and Enter, or tap the target.';root.append(hint);
    const target=document.createElement('button');target.textContent='Tap target';
    target.style.cssText='min-width:100px;min-height:48px;border:2px solid #172b40;border-radius:6px;background:${turn === 2 ? "#1457ac" : "#f0bd30"};color:${turn === 2 ? "white" : "#172b40"}';
    target.onclick=()=>{score++;paint();};root.append(target);
    const restart=document.createElement('button');restart.textContent='Restart game';restart.style.cssText='min-height:48px;margin-left:12px';restart.onclick=()=>{score=0;paint();};root.append(restart);`;
  const chart = `
    const rows=[['Jan',38],['Feb',51],['Mar',47],['Apr',62],['May',70]];
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 500 180');svg.setAttribute('role','img');svg.setAttribute('aria-label','Synthetic completed deliveries, ${turn === 2 ? "horizontal" : "vertical"} bars');svg.style.cssText='display:block;width:100%;max-height:180px';
    rows.forEach(([month,value],i)=>{
      const bar=document.createElementNS(svg.namespaceURI,'rect');
      const attrs=${turn === 2 ? "{x:55,y:i*33+4,width:value*5,height:20}" : "{x:i*95+30,y:160-value*2,width:50,height:value*2}"};
      Object.entries(attrs).forEach(([k,v])=>bar.setAttribute(k,String(v)));bar.setAttribute('fill','#1457ac');svg.append(bar);
      const label=document.createElementNS(svg.namespaceURI,'text');label.setAttribute('x',String(${turn === 2 ? "5" : "i*95+30"}));label.setAttribute('y',String(${turn === 2 ? "i*33+19" : "177"}));label.textContent=month;label.setAttribute('font-size','13');svg.append(label);
    });root.append(svg);
    const table=document.createElement('table');table.style.cssText='font-size:13px;border-spacing:12px 2px';
    table.innerHTML='<caption>Synthetic completed deliveries</caption><thead><tr><th scope="col">Month</th><th scope="col">Deliveries</th></tr></thead><tbody>'+rows.map(([month,value])=>'<tr><th scope="row">'+month+'</th><td>'+value+'</td></tr>').join('')+'</tbody>';root.append(table);`;
  return {
    title,
    entry: "main.js",
    files: [
      {
        path: "main.js",
        code: setup + (domain === "experiences" ? game : chart),
      },
    ],
    dependencies: [],
    assets: [],
  };
}
