import { SplatFileType } from '@sparkjsdev/spark';
export const MAX_SPLAT_FILE_BYTES=64*1024*1024;
export const MAX_IMPORT_SPLATS=500_000;
const MAX_DECOMPRESSED_BYTES=96*1024*1024;
export function validateSplatFileEnvelope(file:Pick<File,'name'|'size'>):'ply'|'splat'|'spz'{
  const ext=file.name.split('.').pop()?.toLowerCase();
  if(ext==='rad')throw new Error('Local RAD import is unavailable because expanded data cannot be bounded. Convert to PLY, SPLAT or SPZ.');
  if(!ext||!['ply','splat','spz'].includes(ext))throw new Error('Choose a .ply, .splat or .spz file.');
  if(!Number.isSafeInteger(file.size)||file.size<16||file.size>MAX_SPLAT_FILE_BYTES)throw new Error('Splat files must be between 16 bytes and 64 MiB.');
  return ext as 'ply'|'splat'|'spz';
}
function countLimit(n:number){if(!Number.isSafeInteger(n)||n<1||n>MAX_IMPORT_SPLATS)throw new Error('The browser import limit is 500,000 Gaussians.');}
export function validatePlyHeader(bytes:Uint8Array):number{
  const text=new TextDecoder().decode(bytes.subarray(0,Math.min(65536,bytes.length)));
  if(!text.startsWith('ply\n')&&!text.startsWith('ply\r\n'))throw new Error('Invalid PLY magic.');
  // Match the decoder's trimmed token grammar. Comments cannot terminate headers.
  const lines=text.split(/\r?\n/).map(row=>row.trim());
  const end=lines.indexOf('end_header');if(end<0)throw new Error('PLY header must end within 64 KiB.');
  const rows=lines.slice(1,end).filter(row=>row&&!/^(comment|obj_info)(\s|$)/.test(row));
  const elements=new Set<string>(), properties=new Set<string>();let count=0,formats=0,propertyCount=0;
  for(const row of rows){const tokens=row.split(/\s+/),[command,type,value]=tokens;
    if(command==='format'){if(tokens.length!==3||!['ascii','binary_little_endian','binary_big_endian'].includes(type)||value!=='1.0'||++formats!==1)throw new Error('Unsupported PLY encoding.');}
    else if(command==='element'){
      if(tokens.length!==3||!/^\d+$/.test(value)||elements.has(type))throw new Error('Invalid or duplicate PLY element.');
      elements.add(type);const n=Number(value);if(!Number.isSafeInteger(n)||n<0||n>MAX_IMPORT_SPLATS)throw new Error('Invalid PLY element count.');
      if(type==='vertex'){countLimit(n);count=n;}else if(type!=='chunk'||n<1)throw new Error('Only Gaussian vertex and chunk elements are accepted.');
    }else if(command==='property'){
      if(tokens.length!==3||!['char','uchar','short','ushort','int','uint','float','double','int8','uint8','int16','uint16','int32','uint32','float32','float64'].includes(type))throw new Error('PLY requires scalar numeric properties.');
      if(++propertyCount>80)throw new Error('PLY has too many properties.');properties.add(value);
    }else throw new Error('Unsupported PLY header command.');
  }
  if(!count||formats!==1)throw new Error('PLY must contain one vertex element and encoding.');
  const gaussian=['f_dc_0','scale_0','rot_0'].every(p=>properties.has(p));
  const compressed=['packed_position','packed_rotation'].every(p=>properties.has(p));
  if(!gaussian&&!compressed)throw new Error('This PLY is a point cloud or mesh. Import a Gaussian PLY with scales and rotations.');
  return count;
}
async function validateSpz(bytes:Uint8Array){
  // SPZ v1-v3 are gzip containers. Read output incrementally, with a hard cap.
  if(bytes[0]!==0x1f||bytes[1]!==0x8b)throw new Error('Expected gzip SPZ data.');
  if(typeof DecompressionStream==='undefined')throw new Error('This browser cannot safely preflight SPZ. Export PLY or SPLAT instead.');
  const stream=new Blob([bytes.slice().buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader=stream.getReader();let size=0;const header=new Uint8Array(16);let copied=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_DECOMPRESSED_BYTES)throw new Error('Expanded SPZ exceeds the 96 MiB safety limit.');if(copied<16){const part=value.subarray(0,16-copied);header.set(part,copied);copied+=part.length;if(copied===16){const h=new DataView(header.buffer);if(h.getUint32(0,true)!==0x5053474e)throw new Error('Invalid SPZ magic.');const version=h.getUint32(4,true);if(version<1||version>3)throw new Error('This bounded importer accepts SPZ versions 1 through 3.');countLimit(h.getUint32(8,true));if(header[12]>3)throw new Error('Invalid SPZ spherical harmonics degree.');}}}
    if(copied!==16)throw new Error('Truncated SPZ header.');
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function preflightSplat(file:File):Promise<{bytes:Uint8Array;fileType:SplatFileType}>{
  const ext=validateSplatFileEnvelope(file);const bytes=new Uint8Array(await file.arrayBuffer());
  if(bytes.length!==file.size)throw new Error('File size changed during import.');
  if(ext==='ply')validatePlyHeader(bytes);
  if(ext==='splat'){
    if(bytes.length%32!==0)throw new Error('SPLAT records must be exactly 32 bytes.');countLimit(bytes.length/32);
    const view=new DataView(bytes.buffer);for(let off=0;off<bytes.length;off+=32){for(let j=0;j<6;j++){const v=view.getFloat32(off+j*4,true);if(!Number.isFinite(v)||Math.abs(v)>10_000||(j>=3&&v<0))throw new Error('SPLAT contains invalid coordinates or scales.');}}
  }
  if(ext==='spz')await validateSpz(bytes);
  return {bytes,fileType:{ply:SplatFileType.PLY,splat:SplatFileType.SPLAT,spz:SplatFileType.SPZ}[ext]};
}
