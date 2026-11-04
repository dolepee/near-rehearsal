(module
  (import "env" "storage_read" (func $storage_read (param i64 i64 i64) (result i64)))
  (import "env" "storage_write" (func $storage_write (param i64 i64 i64 i64 i64) (result i64)))
  (import "env" "read_register" (func $read_register (param i64 i64)))
  (import "env" "register_len" (func $register_len (param i64) (result i64)))
  (import "env" "value_return" (func $value_return (param i64 i64)))
  (import "env" "panic_utf8" (func $panic_utf8 (param i64 i64)))
  (import "env" "predecessor_account_id" (func $predecessor_account_id (param i64)))
  (import "env" "promise_batch_create" (func $promise_batch_create (param i64 i64) (result i64)))
  (import "env" "promise_batch_action_transfer" (func $promise_batch_action_transfer (param i64 i64)))
  (import "env" "promise_return" (func $promise_return (param i64)))
  (memory (export "memory") 1)
  (data (i32.const 0) "r")
  (data (i32.const 32) "state too short: expected v1 refund")
  (data (i32.const 96) "NO_REFUND")
  (data (i32.const 128) "state too short: expected v2 refund")
  (func (export "migrate")
    (local $len i64)
    (local $amount_lo i64)
    (local $amount_hi i64)
    i64.const 1 i64.const 0 i64.const 0
    call $storage_read
    drop
    i64.const 0
    call $register_len
    local.set $len
    local.get $len i64.const 16 i64.ne
    if
      i64.const 39 i64.const 32
      call $panic_utf8
    end
    i64.const 0 i64.const 64
    call $read_register
    i32.const 64
    i64.load align=8
    local.set $amount_lo
    i32.const 72
    i64.load align=8
    local.set $amount_hi
    i32.const 64
    i64.const 2
    i64.store align=8
    i32.const 72
    local.get $amount_lo
    i64.store align=8
    i32.const 80
    local.get $amount_hi
    i64.store align=8
    i64.const 1 i64.const 0 i64.const 24 i64.const 64 i64.const 0
    call $storage_write
    drop)
  (func (export "get_refundable")
    (local $len i64)
    i64.const 1 i64.const 0 i64.const 0
    call $storage_read
    drop
    i64.const 0
    call $register_len
    local.set $len
    local.get $len i64.const 24 i64.ne
    if
      i64.const 41 i64.const 128
      call $panic_utf8
    end
    i64.const 0 i64.const 64
    call $read_register
    i64.const 16 i64.const 72
    call $value_return)
  (func (export "claim_refund")
    (local $len i64)
    (local $version i64)
    (local $amount_lo i64)
    (local $amount_hi i64)
    (local $account_len i64)
    (local $promise i64)
    i64.const 1 i64.const 0 i64.const 0
    call $storage_read
    drop
    i64.const 0
    call $register_len
    local.set $len
    local.get $len i64.const 24 i64.ne
    if
      i64.const 41 i64.const 128
      call $panic_utf8
    end
    i64.const 0 i64.const 64
    call $read_register
    i32.const 64
    i64.load align=8
    local.set $version
    local.get $version i64.const 2 i64.ne
    if
      i64.const 41 i64.const 128
      call $panic_utf8
    end
    i32.const 72
    i64.load align=8
    local.set $amount_lo
    i32.const 80
    i64.load align=8
    local.set $amount_hi
    local.get $amount_lo
    i64.eqz
    local.get $amount_hi
    i64.eqz
    i32.and
    if
      i64.const 9 i64.const 96
      call $panic_utf8
    end
    i64.const 1
    call $predecessor_account_id
    i64.const 1
    call $register_len
    local.set $account_len
    i64.const 1 i64.const 128
    call $read_register
    local.get $account_len i64.const 128
    call $promise_batch_create
    local.set $promise
    local.get $promise
    i64.const 72
    call $promise_batch_action_transfer
    i32.const 64
    i64.const 2    i64.store align=8
    i32.const 72
    i64.const 0    i64.store align=8
    i32.const 80
    i64.const 0    i64.store align=8
    i64.const 1 i64.const 0 i64.const 24 i64.const 64 i64.const 0
    call $storage_write
    drop
    local.get $promise
    call $promise_return)
)
