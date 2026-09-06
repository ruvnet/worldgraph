import {describe,it,expect} from 'vitest';
import {gzipSync} from 'node:zlib';
import {preflightSplat,validatePlyHeader,validateSplatFileEnvelope,MAX_IMPORT_SPLATS,MAX_SPLAT_FILE_BYTES} from './imports';

const encode=(text:string)=>new TextEncoder().encode(text);
const header=(extra='',count=1)=>`ply\nformat ascii 1.0\n${extra}element vertex ${count}\nproperty float x\nproperty float y\nproperty float z\nproperty float f_dc_0\nproperty float scale_0\nproperty float rot_0\nend_header\n`;
describe('local Gaussian import boundary',()=>{
  it('accepts a canonical Gaussian header and normalized whitespace',()=>{
    expect(validatePlyHeader(encode(header()))).toBe(1);
    expect(validatePlyHeader(encode(header().replace('element vertex 1','  element\tvertex\t2 ')))).toBe(2);
  });
  it('rejects hidden or duplicate element counts before decoding',()=>{
    expect(()=>validatePlyHeader(encode(header(' element vertex 100000000\n')))).toThrow();
    expect(()=>validatePlyHeader(encode(header(' element vertex 2\n')))).toThrow(/duplicate/);
    expect(()=>validatePlyHeader(encode(header('',MAX_IMPORT_SPLATS+1)))).toThrow();
  });
  it('does not treat comments as header terminators or Gaussian properties',()=>{
    expect(validatePlyHeader(encode(header('comment end_header\n')))).toBe(1);
    expect(()=>validatePlyHeader(encode(header().replace('end_header\n','comment end_header\n')))).toThrow(/64 KiB/);
    expect(()=>validatePlyHeader(encode('ply\nformat ascii 1.0\nelement vertex 1\ncomment f_dc_0 scale_0 rot_0\nproperty float x\nend_header\n'))).toThrow(/point cloud/);
  });
  it('rejects variable length lists, malformed counts and unknown encodings',()=>{
    for(const text of [header().replace('property float x','property list uchar float x'),header().replace('vertex 1','vertex 1e3'),header().replace('ascii 1.0','ascii 2.0')])expect(()=>validatePlyHeader(encode(text))).toThrow();
  });
  it('disables RAD before reading data and enforces outer byte limits',async()=>{
    expect(()=>validateSplatFileEnvelope({name:'capture.RAD',size:32})).toThrow(/expanded data/);
    expect(()=>validateSplatFileEnvelope({name:'capture.ply',size:MAX_SPLAT_FILE_BYTES+1})).toThrow(/64 MiB/);
    expect(()=>validateSplatFileEnvelope({name:'capture.html',size:32})).toThrow(/Choose/);
  });
  it('accepts complete finite SPLAT records and rejects invalid scales or record lengths',async()=>{
    const bytes=new Uint8Array(32);const view=new DataView(bytes.buffer);view.setFloat32(12,.05,true);
    await expect(preflightSplat(new File([bytes],'valid.splat'))).resolves.toHaveProperty('bytes');
    view.setFloat32(12,-1,true);await expect(preflightSplat(new File([bytes],'invalid.splat'))).rejects.toThrow(/scales/);
    await expect(preflightSplat(new File([new Uint8Array(33)],'invalid.splat'))).rejects.toThrow(/32 bytes/);
  });
  it('checks SPZ count, version and expanded budget before handing data to Spark',async()=>{
    const bytes=new Uint8Array(32);const h=new DataView(bytes.buffer);h.setUint32(0,0x5053474e,true);h.setUint32(4,3,true);h.setUint32(8,MAX_IMPORT_SPLATS+1,true);
    await expect(preflightSplat(new File([Uint8Array.from(gzipSync(bytes))],'over.spz'))).rejects.toThrow(/500,000/);
    h.setUint32(8,1,true);h.setUint32(4,4,true);
    await expect(preflightSplat(new File([Uint8Array.from(gzipSync(bytes))],'v4.spz'))).rejects.toThrow(/versions 1 through 3/);
    await expect(preflightSplat(new File([new Uint8Array(32)],'bad.spz'))).rejects.toThrow(/gzip/);
  });
});
