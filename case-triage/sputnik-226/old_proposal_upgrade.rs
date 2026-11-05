//! Pilot-only reproduction harness for Sputnik PR #226.
//! Locally constructed state, no mainnet import, no product adapter.
//! Run with `--ignored` after building BASE_WASM and CANDIDATE_WASM.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{json, Value};
use near_workspaces::types::NearToken;
use sputnikdao2::{
    Action, Config, ProposalInput, ProposalKind, ProposalOutput, ProposalStatus, VersionedPolicy,
};

fn read_wasm(var: &str) -> Vec<u8> {
    let path = std::env::var(var)
        .unwrap_or_else(|_| panic!("{var} must point to a source-built WASM"));
    std::fs::read(&path).unwrap_or_else(|error| panic!("cannot read {path}: {error}"))
}

#[tokio::test]
#[ignore = "requires source-built BASE_WASM/CANDIDATE_WASM and a local sandbox"]
async fn old_transfer_proposal_survives_real_upgrade_and_migrate(
) -> Result<(), Box<dyn std::error::Error>> {
    let base_wasm = read_wasm("BASE_WASM");
    let candidate_wasm = read_wasm("CANDIDATE_WASM");

    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let dao_account = root
        .create_subaccount("pilot-dao")
        .initial_balance(NearToken::from_near(100))
        .transact()
        .await?
        .into_result()?;

    let deployment = dao_account.deploy(&base_wasm).await?;
    assert!(deployment.is_success(), "base deploy failed: {:?}", deployment.failures());
    let dao = deployment.result;

    let config = Config {
        name: "pilot".to_string(),
        purpose: "locally constructed old-proposal upgrade pilot".to_string(),
        metadata: Base64VecU8(vec![]),
    };
    let policy = VersionedPolicy::Default(vec![root.id().clone()]);
    let init = dao
        .call("new")
        .args_json(json!({"config": config, "policy": policy}))
        .max_gas()
        .transact()
        .await?;
    assert!(init.is_success(), "init failed: {:?}", init.failures());

    let transfer_kind = ProposalKind::Transfer {
        token_id: "".to_string(),
        receiver_id: root.id().clone(),
        amount: U128(1),
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
    assert!(add.is_success(), "add_proposal failed: {:?}", add.failures());
    let proposal_id: u64 = add.json()?;

    let before: ProposalOutput = dao
        .view("get_proposal")
        .args_json(json!({"id": proposal_id}))
        .await?
        .json()?;
    assert_eq!(before.proposal.status, ProposalStatus::InProgress);

    // Real contract entry point: the DAO calls its own update() with the
    // candidate bytes. update() deploys the code and invokes migrate().
    let upgrade = dao
        .call(dao.id(), "update")
        .args(candidate_wasm.clone())
        .max_gas()
        .transact()
        .await?;
    assert!(upgrade.is_success(), "update failed: {:?}", upgrade.failures());

    let code = dao.view_code().await?;
    assert_eq!(code, candidate_wasm, "candidate code hash mismatch");

    let after: ProposalOutput = dao
        .view("get_proposal")
        .args_json(json!({"id": proposal_id}))
        .await?
        .json()?;
    assert_eq!(after.proposal.status, ProposalStatus::InProgress);

    let config_after: Value = dao.view("get_config").await?.json()?;
    assert_eq!(config_after["name"], "pilot");

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
    assert!(approve.is_success(), "old proposal vote failed: {:?}", approve.failures());
    assert_eq!(approve.failures().len(), 0);

    Ok(())
}
