"""Reproduce the seven bundled CC0 assets. Network is used at authoring time only."""
import subprocess,json,hashlib,pathlib
from urllib.parse import urlparse
root=pathlib.Path(__file__).resolve().parents[1]/'public'/'graphics'
root.mkdir(parents=True,exist_ok=True)
def fetch(url):
 parsed=urlparse(url)
 if parsed.scheme!='https' or parsed.hostname not in {'api.polyhaven.com','dl.polyhaven.org'} or parsed.username or parsed.password:
  raise ValueError('Unexpected asset origin')
 return subprocess.check_output(['curl','--fail','--silent','--show-error','--max-time','60','--max-filesize','4194304',url])
entries=[]
for asset,prefix in [('industrial_sunset_02','sunset'),('concrete_floor_02','concrete'),('wood_planks_grey','wood')]:
 metadata=json.loads(fetch('https://api.polyhaven.com/files/'+asset))
 variants=[('hdri','hdr','sunset.hdr')] if prefix=='sunset' else [('Diffuse','jpg',prefix+'-diff.jpg'),('Rough','jpg',prefix+'-rough.jpg'),('nor_gl','jpg',prefix+'-normal.jpg')]
 for kind,ext,name in variants:
  record=metadata[kind]['1k'][ext]
  if not 0 < record['size'] < 4*1024*1024: raise ValueError('Asset exceeds download budget')
  data=fetch(record['url'])
  assert len(data)==record['size'] and hashlib.md5(data).hexdigest()==record['md5'],name
  (root/name).write_bytes(data)
  entries.append(dict(file=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),source=record['url'],asset='https://polyhaven.com/a/'+asset,license='CC0-1.0'))
  print(name,len(data),flush=True)
(root/'provenance.json').write_text(json.dumps(dict(schema='worldgraph.graphics.assets.v1',assets=entries),indent=2)+'\n')
