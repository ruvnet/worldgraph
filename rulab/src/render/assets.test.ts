import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
it('ships every photographic asset with exact provenance and a bounded payload',()=>{
 const manifest=JSON.parse(readFileSync('public/graphics/provenance.json','utf8'));
 expect(manifest.assets).toHaveLength(7);let total=0;
 for(const asset of manifest.assets){expect(asset.file).toMatch(/^[a-z-]+\.(hdr|jpg)$/);const bytes=readFileSync('public/graphics/'+asset.file);expect(bytes.length).toBe(asset.bytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);expect(asset.license).toBe('CC0-1.0');total+=bytes.length;}
 expect(total).toBeLessThan(4*1024*1024);
});
