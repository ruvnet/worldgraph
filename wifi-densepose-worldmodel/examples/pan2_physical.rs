//! Offline preparation/replay or live IPC for structured physical predictions.
use std::{fs::File,io::Read,path::Path,time::Duration};
use serde::de::DeserializeOwned;
use wifi_densepose_worldgraph::{WorldGraph,WorldId};
use wifi_densepose_worldmodel::{physical::*,ExternalModelConfig,ExternalModelKind,SidecarConfig,DeploymentPolicy,CancellationToken};

fn read(path:&str,limit:usize)->Result<Vec<u8>,Box<dyn std::error::Error>>{
    let file=File::open(Path::new(path))?;if !file.metadata()?.is_file(){return Err("input must be a regular file".into());}
    let mut bytes=Vec::new();file.take(limit as u64+1).read_to_end(&mut bytes)?;if bytes.len()>limit{return Err("input exceeds size limit".into());}Ok(bytes)
}
fn json<T:DeserializeOwned>(path:&str)->Result<T,Box<dyn std::error::Error>>{Ok(serde_json::from_slice(&read(path,MAX_PHYSICAL_BYTES)?)?)}

#[tokio::main(flavor="current_thread")]
async fn main()->Result<(),Box<dyn std::error::Error>>{
    let a:Vec<String>=std::env::args().collect();
    if a.len()<5{return Err("usage: pan2_physical prepare GRAPH CONTEXT IDS | replay GRAPH CONTEXT IDS RESPONSE OBSERVATIONS | live GRAPH CONTEXT IDS SOCKET WEIGHTS --terms-accepted".into());}
    let graph=WorldGraph::from_json(&read(&a[2],8*1024*1024)?)?;
    let context:PhysicalContext=json(&a[3])?;let ids:Vec<WorldId>=json(&a[4])?;
    let scene=PreparedPhysicalScene::from_graph(&graph,&ids,context)?;
    let branch=match a[1].as_str(){
        "prepare" if a.len()==5=>{println!("{}",serde_json::to_string_pretty(&serde_json::json!({"request":scene.request(),"request_sha256":scene.request_sha256()?}))?);return Ok(());},
        "replay" if a.len()==7=>scene.accept_json(&read(&a[5],MAX_PHYSICAL_BYTES)?)?,
        "live" if a.len()==8 && a[7]=="--terms-accepted"=>{
            let model=ExternalModelConfig{kind:ExternalModelKind::Pan2,terms_accepted:true,credential_env:None,weights_path:Some(a[6].clone().into())};
            let bridge=Pan2PhysicalBridge::new(SidecarConfig{socket_path:a[5].clone().into(),timeout:Duration::from_secs(600),deployment:DeploymentPolicy::production(),cancellation:CancellationToken::default(),hosted:false},&model)?;
            bridge.predict(&scene).await?
        },_=>return Err("invalid mode or arguments".into())
    };
    let hypothesis=branch.hypothesis_graph(&graph)?;
    let score=if a[1]=="replay"{Some(branch.reconcile(&json(&a[6])?)?)}else{None};
    println!("{}",serde_json::to_string_pretty(&serde_json::json!({"schema_version":1,"observed_state_changed":false,"response":branch.response(),"hypothesis_graph":hypothesis.snapshot(),"score":score,"automatic_promotion":false}))?);
    Ok(())
}
