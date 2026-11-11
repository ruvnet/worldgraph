/**
 * Synthetic simulated-rollout fixture (ADR-204). An FFmpeg test pattern, NOT model output:
 * it exists so the RuLab rollout viewer, its tests and the bundled example work before any
 * real world-model rollout is available.
 *
 * Determinism: with the flags below one FFmpeg build writes identical bytes on every run
 * (checked twice here). Encoded bytes are not stable across FFmpeg/libvpx versions, so the
 * generated files are committed and this script recomputes every length and SHA-256 from the
 * bytes it actually wrote. After regenerating with a different FFmpeg, commit all four files.
 *
 * The index is merged, not replaced: entries for other rollout directories are kept.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ID='synthetic-example',WIDTH=320,HEIGHT=180,FPS=24,DURATION=2;
const root=fileURLToPath(new URL('../rulab/public/simulated/',import.meta.url)),output=join(root,ID);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
await mkdir(output,{recursive:true});

// VP9 in MP4: royalty-free, and decodable by Chromium builds that omit proprietary codecs.
const encode=()=>{
  const args=['-hide_banner','-loglevel','error','-y','-f','lavfi','-i',`testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${DURATION}`,
    '-an','-c:v','libvpx-vp9','-b:v','0','-crf','40','-pix_fmt','yuv420p','-threads','1','-row-mt','0',
    '-fflags','+bitexact','-flags:v','+bitexact','-map_metadata','-1','-movflags','+faststart','-f','mp4',join(output,'clip.mp4')];
  const result=spawnSync('ffmpeg',args,{encoding:'utf8'});
  if(result.error)throw new Error(`ffmpeg could not start: ${result.error.message}`);
  if(result.status!==0)throw new Error(`ffmpeg failed (${result.status}): ${result.stderr}`);
  return readFile(join(output,'clip.mp4'));
};
const clip=await encode();
if(sha256(await encode())!==sha256(clip))throw new Error('ffmpeg produced different bytes on a second run; the fixture is not reproducible on this build.');

const caption=Buffer.from(JSON.stringify({
  schema:'worldgraph.simulated.caption.fixture.v1',
  note:'Synthetic fixture. No world model was prompted; this file stands in for the structured prompt of a real rollout.',
  generator:{tool:'ffmpeg',source:'lavfi testsrc2',codec:'libvpx-vp9'},
  scene:{description:'Moving colour bars and a frame counter.',width:WIDTH,height:HEIGHT,fps:FPS,durationSec:DURATION},
  actions:[],
},null,2)+'\n');

const manifest={
  format:'worldgraph.simulated.rollout',version:1,name:'Synthetic test pattern (not model output)',simulated:true,
  media:{file:'clip.mp4',sha256:sha256(clip),bytes:clip.length,mediaType:'video/mp4',width:WIDTH,height:HEIGHT,fps:FPS,durationSec:DURATION},
  caption:{file:'caption.json',sha256:sha256(caption),bytes:caption.length},
  // serde form of Rust SimulatedFrameEnvelope; snake_case is intentional.
  envelope:{schema_version:1,session_id:'mock-1',epoch:0,sequence:0,chunk:{
    frames:[{transport:'file',locator:'clip.mp4',content_hash:`sha256:${sha256(clip)}`,byte_length:clip.length,media_type:'video/mp4'}],
    provenance:{provider:'mock',model:'deterministic-fixture',checkpoint:'builtin-v1',runtime_version:'ffmpeg-testsrc2-fixture',
      source_snapshot_hash:'none:synthetic-fixture-has-no-source-snapshot',source_stream_epoch:0,
      prompt_action_hash:`sha256:${sha256(caption)}`,generation_seed:0,generation_sequence:0,simulated:true,confidence:0,
      privacy:{projection_id:'synthetic-fixture-no-scene-data',hosted_processing_approved:false,redactions_applied:0,retention:'policy_bound'},
      license:{license_id:'MIT OR Apache-2.0',usage:'production',redistribution_allowed:true,attribution_required:false,
        notice:'FFmpeg testsrc2 pattern written by scripts/create-simulated-rollout-example.mjs. Not model output.'}}}},
};
const manifestText=JSON.stringify(manifest,null,2)+'\n';
await writeFile(join(output,'caption.json'),caption);
await writeFile(join(output,'rollout.json'),manifestText);

let index={format:'worldgraph.simulated.index',version:1,rollouts:[]};
try{
  const existing=JSON.parse(await readFile(join(root,'index.json'),'utf8'));
  if(existing?.format===index.format&&existing.version===1&&Array.isArray(existing.rollouts))index=existing;
}catch(error){if(error.code!=='ENOENT')throw error;}
if(!index.rollouts.some(entry=>entry.id===ID))index.rollouts.unshift({id:ID,path:`${ID}/rollout.json`});
await writeFile(join(root,'index.json'),JSON.stringify(index,null,2)+'\n');

console.log(JSON.stringify({source:'synthetic',id:ID,clip:{bytes:clip.length,sha256:sha256(clip)},captionBytes:caption.length,
  manifestBytes:Buffer.byteLength(manifestText),indexed:index.rollouts.map(entry=>entry.id)},null,2));
