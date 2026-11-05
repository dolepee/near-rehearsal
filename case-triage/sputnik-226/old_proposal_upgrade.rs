//! Pilot-only reproduction harness for Sputnik PR #226.
//! Locally constructed state, no mainnet import, no product adapter.
//! Run with `--ignored` after building BASE_WASM and CANDIDATE_WASM.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{json, Value};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Finality, NearToken};
use near_workspaces::Worker;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use sputnikdao2::{
    Action, Config, ProposalInput, ProposalKind, VersionedPolicy,
};

fn read_wasm(var: &str) -> Vec<u8> {
    let path = std::env::var(var)
        .unwrap_or_else(|_| panic!("{var} must point to a source-built WASM"));
    std::fs::read(&path).unwrap_or_else(|error| panic!("cannot read {path}: {error}"))
}

fn evidence_path() -> PathBuf {
    PathBuf::from(std::env::var("EVIDENCE_PATH").unwrap_or_else(|_| "pilot/evidence.log".to_string()))
}

fn append_stage(path: &Path, stage_name: &str, execution: &ExecutionFinalResult) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("cannot create evidence directory");
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("cannot open evidence file");
    let record = json!({
        "schema": "near-rehearsal/pilot/sputnik-226-rust-evidence/v1",
        "stage": stage_name,
        "execution": format!("{execution:#?}"),
    });
    writeln!(file, "{record}").expect("cannot write evidence");
}

async fn wait_finalized(
    worker: &Worker<Sandbox>,
    execution: &ExecutionFinalResult,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut target = 0u64;
    for outcome in execution.outcomes() {
        let block = worker.view_block().block_hash(outcome.block_hash).await?;
        target = target.max(block.height());
    }
    for _ in 0..120 {
        let finalized = worker.view_block().finality(Finality::Final).await?;
        if finalized.height() >= target {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(format!("finality barrier timed out; target block {target}").into())
}

#[tokio::test]
#[ignore = "requires source-built BASE_WASM/CANDIDATE_WASM and a local sandbox"]
async fn old_transfer_proposal_survives_real_upgrade_and_migrate(
) -> Result<(), Box<dyn std::error::Error>> {
    let base_wasm = read_wasm("BASE_WASM");
    let candidate_wasm = read_wasm("CANDIDATE_WASM");

    let worker = near_workspaces::sandbox().await?;
    let evidence = evidence_path();
    let root = worker.root_account()?;
    let dao_account = root
        .create_subaccount("pilot-dao")
        .initial_balance(NearToken::from_near(100))
        .transact()
        .await?
        .into_result()?;
    let recipient = root
        .create_subaccount("pilot-recipient")
        .initial_balance(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;

    let deployment = dao_account.deploy(&base_wasm).await?;
    append_stage(&evidence, "deploy", &deployment.details);
    assert!(
        deployment.is_success(),
        "base deploy failed: {:?}",
        deployment.details.failures()
    );
    wait_finalized(&worker, &deployment.details).await?;
    let dao = deployment.result;

    let config = Config {
        name: "pilot".to_string(),
        purpose: "locally constructed old-proposal upgrade pilot".to_string(),
        metadata: Base64VecU8(vec![]),
    };
    let policy = VersionedPolicy::Default(vec![root.id().clone()]);
    // Root calls new(), so FactoryInfo.factory_id is persisted as root.
    let init = root
        .call(dao.id(), "new")
        .args_json(json!({"config": config, "policy": policy}))
        .max_gas()
        .transact()
        .await?;
    append_stage(&evidence, "init", &init);
    assert!(init.is_success(), "init failed: {:?}", init.failures());
    wait_finalized(&worker, &init).await?;

    let config_before: Value = dao.view("get_config").await?.json()?;

    let transfer_amount = NearToken::from_near(1);
    let transfer_kind = ProposalKind::Transfer {
        token_id: "".to_string(),
        receiver_id: recipient.id().clone(),
        amount: U128(transfer_amount.as_yoctonear()),
        msg: None,
    };
    let add = root
        .call(dao.id(), "add_proposal")
        .args_json(json!({
            "proposal": ProposalInput {
                description: "pre-upgrade transfer proposal".to_string(),
                kind: transfer_kind.clone(),
            }
        }))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?;
    append_stage(&evidence, "add_proposal", &add);
    assert!(add.is_success(), "add_proposal failed: {:?}", add.failures());
    wait_finalized(&worker, &add).await?;
    let proposal_id: u64 = add.json()?;

    // The old binary does not have the candidate's last_actions_log field.
    // Read the pre-upgrade view as raw JSON instead of forcing it into the
    // candidate ProposalOutput schema.
    let before: Value = dao
        .view("get_proposal")
        .args_json(json!({"id": proposal_id}))
        .await?
        .json()?;
    assert_eq!(before["status"], "InProgress", "old proposal status: {before}");
    assert_eq!(
        before["kind"]["Transfer"]["receiver_id"],
        recipient.id().as_str(),
        "old proposal kind: {before}"
    );
    assert!(
        before.get("last_actions_log").is_none(),
        "old schema unexpectedly has last_actions_log: {before}"
    );

    let recipient_before = recipient.view_account().await?.balance;

    // Honest fixture: root is the persisted factory. Root calls update() with
    // raw candidate bytes, exercising the authorized factory branch. This is
    // NOT governance UpgradeSelf and NOT the self-call/callback branch.
    let upgrade = root
        .call(dao.id(), "update")
        .args(candidate_wasm.clone())
        .max_gas()
        .transact()
        .await?;
    append_stage(&evidence, "update", &upgrade);
    assert!(upgrade.is_success(), "update failed: {:?}", upgrade.failures());
    wait_finalized(&worker, &upgrade).await?;

    let code = dao.view_code().await?;
    assert_eq!(code, candidate_wasm, "candidate code hash mismatch");

    let after: Value = dao
        .view("get_proposal")
        .args_json(json!({"id": proposal_id}))
        .await?
        .json()?;
    assert_eq!(after["status"], "InProgress", "post-upgrade proposal status: {after}");

    let config_after: Value = dao.view("get_config").await?.json()?;
    assert_eq!(config_after, config_before, "get_config changed across upgrade");

    let approve = root
        .call(dao.id(), "act_proposal")
        .args_json(json!({
            "id": proposal_id,
            "action": Action::VoteApprove,
            "proposal": transfer_kind,
        }))
        .max_gas()
        .transact()
        .await?;
    append_stage(&evidence, "approve", &approve);
    assert!(approve.is_success(), "old proposal vote failed: {:?}", approve.failures());
    wait_finalized(&worker, &approve).await?;

    let final_proposal: Value = dao
        .view("get_proposal")
        .args_json(json!({"id": proposal_id}))
        .await?
        .json()?;
    assert_eq!(final_proposal["status"], "Approved", "proposal was not approved: {final_proposal}");
    assert_eq!(
        final_proposal["votes"][root.id().as_str()],
        "Approve",
        "root vote did not persist: {final_proposal}"
    );

    let recipient_after = recipient.view_account().await?.balance;
    assert_eq!(
        recipient_after.as_yoctonear(),
        recipient_before.as_yoctonear() + transfer_amount.as_yoctonear(),
        "transfer recipient balance did not increase by the proposal amount"
    );

    append_stage(&evidence, "complete", &approve);
    Ok(())
}
