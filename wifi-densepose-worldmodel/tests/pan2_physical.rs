//! Physical hypothesis invariants and real Unix-socket protocol tests.
use std::time::Duration;
use wifi_densepose_worldgraph::{WorldGraph,WorldId,WorldNode,EnuPoint};
use wifi_densepose_worldmodel::{physical::*,PrivacyDecision,RetentionPolicy,ExternalModelConfig,ExternalModelKind,SidecarConfig,DeploymentPolicy,CancellationToken};

fn setup()->(WorldGraph,WorldId,PhysicalContext){
    let mut g=WorldGraph::new(Default::default());
    let id=g.upsert_node(WorldNode::PersonTrack{id:WorldId::UNASSIGNED,track_id:7,last_position:EnuPoint{east_m:0.0,north_m:0.0,up_m:1.0},reid_embedding_ref:Some("SECRET-EMBEDDING-NOT-FOR-MODEL".into())});
    let ctx=PhysicalContext{source_epoch:3,observed_at_ms:1000,frame_id:"room-enu".into(),calibration_id:"survey-1".into(),action:"person moves toward entrance".into(),horizon_ms:2000,generation_seed:123,
        bounds:PhysicalBounds{min:[-5.0,-5.0,0.0],max:[5.0,5.0,3.0]},obstacles:vec![],max_speed_mps:3.0,
        privacy:PrivacyDecision{projection_id:"authorized-tracks".into(),hosted_processing_approved:false,redactions_applied:1,retention:RetentionPolicy::Ephemeral}};
    (g,id,ctx)
}
fn response(s:&PreparedPhysicalScene)->Pan2PhysicalResponse{
    Pan2PhysicalResponse{schema_version:1,request_sha256:s.request_sha256().unwrap(),model_sha256:"a".repeat(64),artifact_sha256:"b".repeat(64),extractor_version:"synthetic-contract-fixture/1".into(),frame_id:"room-enu".into(),calibration_id:"survey-1".into(),execution:PhysicalExecution::Fixture,
        trajectories:vec![PhysicalTrajectory{track_id:7,points:vec![PhysicalPoint{offset_ms:1000,position_m:[1.0,0.0,1.0]},PhysicalPoint{offset_ms:2000,position_m:[2.0,0.0,1.0]}]}]}
}
fn observations(s:&PreparedPhysicalScene)->PhysicalObservations{
    PhysicalObservations{request_sha256:s.request_sha256().unwrap(),frame_id:"room-enu".into(),calibration_id:"survey-1".into(),observed_at_ms:1000,samples:vec![PhysicalObservation{track_id:7,offset_ms:1000,position_m:[1.1,0.0,1.0]},PhysicalObservation{track_id:7,offset_ms:2000,position_m:[1.9,0.0,1.0]}]}
}
#[test]
fn projection_hypothesis_graph_roundtrip_and_sensor_reconciliation(){
    let (g,id,ctx)=setup();let original=g.to_json().unwrap();
    let s=PreparedPhysicalScene::from_graph(&g,&[id],ctx).unwrap();
    assert!(!serde_json::to_string(s.request()).unwrap().contains("SECRET"));
    let r=response(&s);let branch=s.accept_json(&serde_json::to_vec(&r).unwrap()).unwrap();
    let hypotheses=branch.hypothesis_graph(&g).unwrap();assert_eq!(hypotheses.node_count(),g.node_count()+1);assert_eq!(hypotheses.edge_count(),1);
    let copy=WorldGraph::from_json(&hypotheses.to_json().unwrap()).unwrap();
    assert_eq!(copy.node_count(),2);assert_eq!(g.to_json().unwrap(),original);
    match copy.node(id).unwrap(){WorldNode::PersonTrack{last_position,..}=>assert_eq!(last_position.east_m,0.0),_=>panic!("track changed")}
    let score=branch.reconcile(&observations(&s)).unwrap();
    assert!((score.forecast_rmse_m-0.1).abs()<1e-10);assert!(score.stationary_rmse_m>1.5);assert_eq!(score.execution,PhysicalExecution::Fixture);
    assert!(copy.to_json().unwrap().windows(b"physical_hypothesis".len()).any(|w|w==b"physical_hypothesis"));
}
#[test]
fn invalid_predictions_and_observations_fail_closed(){
    let (mut g,id,ctx)=setup();let s=PreparedPhysicalScene::from_graph(&g,&[id],ctx).unwrap();
    for case in 0..10 {
        let mut r=response(&s);
        match case{0=>r.request_sha256="c".repeat(64),1=>r.frame_id="camera-pixels".into(),2=>r.calibration_id="other".into(),3=>r.trajectories[0].track_id=8,
            4=>r.trajectories[0].points[0].offset_ms=0,5=>r.trajectories[0].points[1].offset_ms=1000,6=>r.trajectories[0].points[1].position_m=[99.0,0.0,1.0],
            7=>r.trajectories[0].points[0].position_m=[4.0,0.0,1.0],8=>r.trajectories.push(r.trajectories[0].clone()),_=>r.model_sha256="unpinned".into()}
        assert!(s.accept_json(&serde_json::to_vec(&r).unwrap()).is_err(),"case {case}");
    }
    assert!(s.accept_json(&vec![b' ';MAX_PHYSICAL_BYTES+1]).is_err());
    let b=s.accept_json(&serde_json::to_vec(&response(&s)).unwrap()).unwrap();
    for case in 0..5 {let mut o=observations(&s);match case{0=>{o.samples.pop();},1=>o.samples[1]=o.samples[0].clone(),2=>o.samples[0].offset_ms=1001,3=>o.observed_at_ms=1001,_=>o.samples[0].position_m[0]=f64::NAN};assert!(b.reconcile(&o).is_err());}
    g.upsert_node(WorldNode::PersonTrack{id,track_id:7,last_position:EnuPoint{east_m:0.5,north_m:0.0,up_m:1.0},reid_embedding_ref:None});
    assert!(b.hypothesis_graph(&g).is_err());
}
#[test]
fn segment_collision_detects_tunnelling_and_invalid_projection(){
    let(g,id,mut ctx)=setup();ctx.obstacles.push(PhysicalBounds{min:[0.4,-0.5,0.0],max:[0.6,0.5,2.0]});
    let s=PreparedPhysicalScene::from_graph(&g,&[id],ctx.clone()).unwrap();
    assert!(s.accept_json(&serde_json::to_vec(&response(&s)).unwrap()).is_err());
    assert!(PreparedPhysicalScene::from_graph(&g,&[id,id],ctx.clone()).is_err());
    ctx.frame_id.clear();assert!(PreparedPhysicalScene::from_graph(&g,&[id],ctx).is_err());
}

#[cfg(unix)]
fn config(path:std::path::PathBuf,timeout:Duration)->SidecarConfig{SidecarConfig{socket_path:path,timeout,deployment:DeploymentPolicy::production(),cancellation:CancellationToken::default(),hosted:false}}
#[cfg(unix)]
fn model()->ExternalModelConfig{ExternalModelConfig{kind:ExternalModelKind::Pan2,terms_accepted:true,credential_env:None,weights_path:Some(std::env::current_dir().unwrap())}}

#[cfg(unix)]
#[tokio::test]
async fn real_unix_protocol_e2e(){
    use tokio::{net::UnixListener,io::{AsyncBufReadExt,AsyncWriteExt,BufReader}};
    let (g,id,ctx)=setup();let s=PreparedPhysicalScene::from_graph(&g,&[id],ctx).unwrap();
    let path=std::env::temp_dir().join(format!("wg-pan2-{}-{}.sock",std::process::id(),s.request_sha256().unwrap()[..8].to_owned()));
    let listener=UnixListener::bind(&path).unwrap();let expected=s.request_sha256().unwrap();let r=response(&s);
    let server=tokio::spawn(async move{let (socket,_)=listener.accept().await.unwrap();let (reader,mut writer)=socket.into_split();let mut line=String::new();BufReader::new(reader).read_line(&mut line).await.unwrap();
        let value:serde_json::Value=serde_json::from_str(&line).unwrap();assert_eq!(value["schema_version"],1);assert!(!line.contains("SECRET"));assert_eq!(r.request_sha256,expected);
        let mut bytes=serde_json::to_vec(&r).unwrap();bytes.push(b'\n');writer.write_all(&bytes).await.unwrap();});
    let bridge=Pan2PhysicalBridge::new(config(path.clone(),Duration::from_secs(1)),&model()).unwrap();
    let b=bridge.predict(&s).await.unwrap();assert_eq!(b.hypothesis_graph(&g).unwrap().node_count(),2);assert!(b.reconcile(&observations(&s)).unwrap().forecast_rmse_m<0.11);
    server.await.unwrap();std::fs::remove_file(path).unwrap();
}
#[cfg(unix)]
#[tokio::test]
async fn timeout_cancellation_and_provider_admission(){
    use tokio::net::UnixListener;
    let(g,id,ctx)=setup();let s=PreparedPhysicalScene::from_graph(&g,&[id],ctx).unwrap();
    let path=std::env::temp_dir().join(format!("wg-pan2-timeout-{}.sock",std::process::id()));
    let listener=UnixListener::bind(&path).unwrap();
    let server=tokio::spawn(async move{let (_socket,_)=listener.accept().await.unwrap();tokio::time::sleep(Duration::from_secs(1)).await;});
    let b=Pan2PhysicalBridge::new(config(path.clone(),Duration::from_millis(20)),&model()).unwrap();
    assert!(matches!(b.predict(&s).await,Err(wifi_densepose_worldmodel::WorldModelError::Timeout{..})));
    let cfg=config(path.clone(),Duration::from_secs(1));cfg.cancellation.cancel();let b=Pan2PhysicalBridge::new(cfg,&model()).unwrap();assert!(matches!(b.predict(&s).await,Err(wifi_densepose_worldmodel::WorldModelError::Cancelled)));
    let mut m=model();m.terms_accepted=false;assert!(Pan2PhysicalBridge::new(config(path.clone(),Duration::from_secs(1)),&m).is_err());
    m=model();m.weights_path=None;assert!(Pan2PhysicalBridge::new(config(path.clone(),Duration::from_secs(1)),&m).is_err());
    server.abort();std::fs::remove_file(path).unwrap();
    assert_eq!(ExternalModelKind::Pan2.license_policy().license_id,"Apache-2.0");
}

#[cfg(unix)]
#[tokio::test]
async fn oversized_and_unterminated_ipc_responses_reject(){
    use tokio::{net::UnixListener,io::AsyncWriteExt};
    let(g,id,ctx)=setup();let s=PreparedPhysicalScene::from_graph(&g,&[id],ctx).unwrap();
    for case in 0..3 {
        let path=std::env::temp_dir().join(format!("wg-pan2-wire-{}-{case}.sock",std::process::id()));
        let listener=UnixListener::bind(&path).unwrap();
        let bytes=match case{0=>vec![b' ';MAX_PHYSICAL_BYTES+2],1=>b"{}".to_vec(),_=>b"{\"schema_version\":99}\n".to_vec()};
        let server=tokio::spawn(async move{let(mut socket,_)=listener.accept().await.unwrap();let _=socket.write_all(&bytes).await;});
        let b=Pan2PhysicalBridge::new(config(path.clone(),Duration::from_secs(1)),&model()).unwrap();
        assert!(b.predict(&s).await.is_err());server.await.unwrap();std::fs::remove_file(path).unwrap();
    }
}
