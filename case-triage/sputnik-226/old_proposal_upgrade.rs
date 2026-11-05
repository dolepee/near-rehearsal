//! Pilot-only reproduction harness for Sputnik PR #226.
//! Locally constructed state, no mainnet import, no product adapter.
//! Run with `--ignored` after building BASE_WASM and CANDIDATE_WASM.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{json, Value};
use near_workspaces::types::NearToken;
use sputnikdao2::{
    Action, Config, ProposalInput, ProposalKind, VersionedPolicy,
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
    let recipient = root
        .create_subaccount("pilot-recipient")
        .initial_balance(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;

    let deployment = dao_account.deploy(&base_wasm).await?;
    assert!(
        deployment.is_success(),
        "base deploy failed: {:?}",
        deployment.details.failures()
    );
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
    assert!(add.is_success(), "add_proposal failed: {:?}", add.failures());
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

    // Contract::call(function) is the self-call API: it signs as the DAO
    // account and targets the contract's own account.
    let upgrade = dao
        .call("update")
        .args(candidate_wasm.clone())
        .max_gas()
        .transact()
        .await?;
    assert!(upgrade.is_success(), "update failed: {:?}", upgrade.failures());

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
    assert!(approve.is_success(), "old proposal vote failed: {:?}", approve.failures());

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

    Ok(())
}
