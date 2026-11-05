(module
  (import "env" "storage_read" (func $storage_read (param i64 i64 i64) (result i64)))
  (import "env" "storage_write" (func $storage_write (param i64 i64 i64 i64 i64) (result i64)))
  (import "env" "read_register" (func $read_register (param i64 i64)))
  (import "env" "register_len" (func $register_len (param i64) (result i64)))
  (import "env" "value_return" (func $value_return (param i64 i64)))
  (import "env" "panic_utf8" (func $panic_utf8 (param i64 i64)))
  (import "env" "predecessor_account_id" (func $predecessor_account_id (param i64)))
  (import "env" "current_account_id" (func $current_account_id (param i64)))
  (import "env" "promise_batch_create" (func $promise_batch_create (param i64 i64) (result i64)))
  (import "env" "promise_batch_action_transfer" (func $promise_batch_action_transfer (param i64 i64)))
  (import "env" "promise_return" (func $promise_return (param i64)))
  (memory (export "memory") 1)
  (data (i32.const 1000) "r")
  (data (i32.const 128) "NO_REFUND")
  (data (i32.const 144) "OUTSIDER")
  (data (i32.const 160) "MIGRATION")
  (data (i32.const 176) "ALREADY_INIT")
  (data (i32.const 300) "refunduser.test.near")
  (func $bytesEqual (param $a i32) (param $b i32) (param $len i32) (result i32)
    (local $i i32)
    i32.const 0
    local.set $i
    block $done
      loop $loop
        local.get $i
        local.get $len
        i32.ge_u
        br_if $done
        local.get $a
        local.get $i
        i32.add
        i32.load8_u
        local.get $b
        local.get $i
        i32.add
        i32.load8_u
        i32.ne
        if
          i32.const 0
          return
        end
        local.get $i
        i32.const 1
        i32.add
        local.set $i
        br $loop
      end
    end
    i32.const 1)
  (func $sameAccount (param $a i64) (param $b i64) (result i32)
    (local $alen i64)
    (local $blen i64)
    local.get $a
    call $register_len
    local.set $alen
    local.get $b
    call $register_len
    local.set $blen
    local.get $alen
    local.get $blen
    i64.ne
    if (result i32)
      i32.const 0
    else
      local.get $a
      i64.const 512
      call $read_register
      local.get $b
      i64.const 640
      call $read_register
      i32.const 512
      i32.const 640
      local.get $alen
      i32.wrap_i64
      call $bytesEqual
    end)
  (func $beneficiaryMatches (result i32)
    (local $len i64)
    i64.const 1
    call $predecessor_account_id
    i64.const 1
    call $register_len
    local.set $len
    local.get $len
    i64.const 20
    i64.ne
    if (result i32)
      i32.const 0
    else
      i64.const 1
      i64.const 512
      call $read_register
      i32.const 16
      i32.const 512
      i32.const 20
      call $bytesEqual
    end)
  (func $requireSelf
    (local $ok i32)
    i64.const 1
    call $predecessor_account_id
    i64.const 2
    call $current_account_id
    i64.const 1
    i64.const 2
    call $sameAccount
    local.set $ok
    local.get $ok
    i32.eqz
    if
      i64.const 9 i64.const 160
      call $panic_utf8
    end)
  (func $writeAmount (param $lo i64) (param $hi i64)
    i32.const 80
    local.get $lo
    i64.store align=8
    i32.const 88
    local.get $hi
    i64.store align=8)
  (func (export "init")
    i64.const 1 i64.const 1000 i64.const 0
    call $storage_read
    i64.eqz
    i32.eqz
    if
      i64.const 12 i64.const 176
      call $panic_utf8
    end
    call $requireSelf
    i32.const 0
    i64.const 1
    i64.store align=8
    i32.const 8
    i64.const 20
    i64.store align=8
    i32.const 16
    i32.const 300
    i64.load align=1
    i64.store align=1
    i32.const 24
    i32.const 308
    i64.load align=1
    i64.store align=1
    i32.const 32
    i32.const 316
    i32.load align=1
    i32.store align=1
    i32.const 80
    i64.const 0x02c7e14af6800000
    i64.store align=8
    i32.const 88
    i64.const 0x152d
    i64.store align=8
    i64.const 1 i64.const 1000 i64.const 96 i64.const 0 i64.const 0
    call $storage_write
    drop)
  (func (export "migrate")
    (local $len i64)
    (local $version i64)
    i64.const 1 i64.const 1000 i64.const 0
    call $storage_read
    drop
    i64.const 0
    call $register_len
    local.set $len
    local.get $len
    i64.const 96
    i64.ne
    if
      i64.const 9 i64.const 160
      call $panic_utf8
    end
    call $requireSelf
    i64.const 0 i64.const 0
    call $read_register
    i32.const 0
    i64.load align=8
    local.set $version
    local.get $version
    i64.const 1
    i64.ne
    if
      i64.const 9 i64.const 160
      call $panic_utf8
    end
    i32.const 0
    i64.const 2
    i64.store align=8
    i32.const 80
    i64.const 0
    i64.store align=8
    i32.const 88
    i64.const 0
    i64.store align=8
    i64.const 1 i64.const 1000 i64.const 96 i64.const 0 i64.const 0
    call $storage_write
    drop)
  (func (export "claim_refund")
    (local $len i64)
    (local $amount_lo i64)
    (local $amount_hi i64)
    (local $account_len i64)
    (local $promise i64)
    i64.const 1 i64.const 1000 i64.const 0
    call $storage_read
    drop
    i64.const 0
    call $register_len
    local.set $len
    local.get $len
    i64.const 96
    i64.ne
    if
      i64.const 9 i64.const 160
      call $panic_utf8
    end
    i64.const 0 i64.const 0
    call $read_register
    i32.const 0
    i64.load align=8
    i64.const 2
    i64.ne
    if
      i64.const 9 i64.const 160
      call $panic_utf8
    end

    call $beneficiaryMatches
    i32.eqz
    if
      i64.const 8 i64.const 144
      call $panic_utf8
    end
    i32.const 80
    i64.load align=8
    local.set $amount_lo
    i32.const 88
    i64.load align=8
    local.set $amount_hi
    local.get $amount_lo
    i64.eqz
    local.get $amount_hi
    i64.eqz
    i32.and
    if
      i64.const 9 i64.const 128
      call $panic_utf8
    end
    i64.const 1
    call $predecessor_account_id
    i64.const 1
    call $register_len
    local.set $account_len
    i64.const 1 i64.const 512
    call $read_register
    local.get $account_len
    i64.const 512
    call $promise_batch_create
    local.set $promise
    local.get $promise
    i64.const 80
    call $promise_batch_action_transfer
    i64.const 0
    i64.const 0
    call $writeAmount
    i64.const 1 i64.const 1000 i64.const 96 i64.const 0 i64.const 0
    call $storage_write
    drop
    local.get $promise
    call $promise_return)
  (func (export "get_refundable")
    (local $len i64)
    i64.const 1 i64.const 1000 i64.const 0
    call $storage_read
    drop
    i64.const 0
    call $register_len
    local.set $len
    local.get $len
    i64.const 96
    i64.ne
    if
      i64.const 9 i64.const 160
      call $panic_utf8
    end
    i64.const 0 i64.const 0
    call $read_register
    i64.const 16 i64.const 80
    call $value_return)
)
