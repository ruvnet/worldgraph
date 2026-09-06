/** Deterministic synthetic Gaussian geometry. No photographs or measured capture. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const output=fileURLToPath(new URL('../rulab/public/capture-example/',import.meta.url));
await mkdir(output,{recursive:true});
const manifest={format:'worldgraph.rulab.capture',version:1,name:'Synthetic scanner study',source:'synthetic',coordinateSystem:'right-handed-y-up',units:'metres',duration:4,bounds:{min:[-5,-.2,-4],max:[5,4.5,4]},frames:[]};
const sizes=[];
for(let frame=0;frame<4;frame++){
  const kernels=[];let seed=18421;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  function add(p,s,color,opacity=230,q=[1,0,0,0]){kernels.push({p,s,color,opacity,q});}
  const warm=[159,145,123],wood=[173,121,67],metal=[205,210,205],dark=[46,56,61],teal=[102,213,194];
  // Spatial floor: anisotropy is thin vertically, never a panorama projection.
  for(let x=-4.4;x<=4.4;x+=.22)for(let z=-3.3;z<=3.3;z+=.22){const n=(random()-.5)*15;add([x,0,z],[.15,.018,.15],warm.map(c=>Math.round(c+n)),215);}
  // Rear wall, timber side panels, and overhead luminaires.
  for(let x=-4.4;x<=4.4;x+=.28)for(let y=.25;y<=3.9;y+=.28)add([x,y,-3.5],[.19,.19,.016],x<-2?wood:[94,102,101],220);
  for(const x of [-4.3,-3.9,-3.5,-3.1])for(let y=.2;y<4;y+=.16)add([x,y,-3.36],[.046,.11,.028],wood);
  for(const z of [-2.7,0,2.7])for(let x=-4.2;x<=4.2;x+=.17)add([x,4.1,z],[.12,.035,.05],[236,199,143],240);
  // A compact worktable behind the scanner, with visible leg geometry.
  for(let x=1.4;x<=3.8;x+=.19)for(let z=-2.5;z<=-1.35;z+=.19)add([x,1.1,z],[.13,.035,.13],wood);
  for(const x of [1.5,3.65])for(const z of [-2.4,-1.45])for(let y=.1;y<1.1;y+=.11)add([x,y,z],[.045,.08,.045],dark);
  // Cylindrical robot base and two articulated links. One shared world frame.
  for(let y=.12;y<=.7;y+=.085)for(let a=0;a<Math.PI*2;a+=Math.PI/8)add([Math.cos(a)*.36,y,Math.sin(a)*.36],[.10,.065,.10],dark);
  const shoulder=[-.7,-.22,.32,-.46][frame],elbow=[.9,.42,-.28,.62][frame];
  const base=[0,.75,0];
  function link(from,length,angle,radius,color){
    const to=[from[0]-Math.sin(angle)*length,from[1]+Math.cos(angle)*length,from[2]];
    const q=[Math.cos(angle/2),0,0,Math.sin(angle/2)];
    for(let t=0;t<=1.001;t+=.07)for(let a=0;a<Math.PI*2;a+=Math.PI/6){const localX=Math.cos(a)*radius,localZ=Math.sin(a)*radius;add([from[0]+(to[0]-from[0])*t+Math.cos(angle)*localX,from[1]+(to[1]-from[1])*t+Math.sin(angle)*localX,from[2]+localZ],[.075,.09,.075],color,235,q);}return to;
  }
  function joint(point){for(let a=0;a<Math.PI*2;a+=Math.PI/10)for(const z of [-.15,-.05,.05,.15])add([point[0]+Math.cos(a)*.19,point[1]+Math.sin(a)*.19,z],[.074,.074,.075],dark);}
  joint(base);const hinge=link(base,1.22,shoulder,.16,metal);joint(hinge);const tip=link(hinge,1.04,shoulder+elbow,.13,metal);joint(tip);
  // Teal scanner at the tool tip makes sample-to-sample motion easy to identify.
  for(let x=-.24;x<=.24;x+=.08)for(let y=-.15;y<=.15;y+=.075)add([tip[0]+x,tip[1]+y,.22],[.055,.055,.065],teal);
  for(let x=-.35;x<=.35;x+=.07)for(let z=-.25;z<=.25;z+=.07)add([1.3+x,.24,z],[.05,.055,.05],[218,171,94]);
  const data=Buffer.alloc(kernels.length*32);
  kernels.forEach(({p,s,color,opacity,q},index)=>{const offset=index*32;for(let i=0;i<3;i++){data.writeFloatLE(p[i],offset+i*4);data.writeFloatLE(s[i],offset+12+i*4);}for(let i=0;i<3;i++)data[offset+24+i]=color[i];data[offset+27]=opacity;for(let i=0;i<4;i++)data[offset+28+i]=Math.max(0,Math.min(255,Math.round(128+q[i]*128)));});
  const file=`frame-${String(frame).padStart(3,'0')}.splat`;await writeFile(new URL(file,`file://${output}`),data);
  manifest.frames.push({time:frame,file,sha256:createHash('sha256').update(data).digest('hex')});sizes.push({file,gaussians:kernels.length,bytes:data.length});
}
const text=JSON.stringify(manifest,null,2)+'\n';await writeFile(new URL('capture.json',`file://${output}`),text);
console.log(JSON.stringify({source:'synthetic',frames:sizes,manifestBytes:Buffer.byteLength(text),totalBytes:sizes.reduce((n,f)=>n+f.bytes,Buffer.byteLength(text))},null,2));
