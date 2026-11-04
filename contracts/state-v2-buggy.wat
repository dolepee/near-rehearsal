(module
  (import "env" "storage_read" (func $storage_read (param i64 i64 i64) (result i64)))
  (import "env" "storage_write" (func $storage_write (param i64 i64 i64 i64 i64) (result i64)))
  (import "env" "read_register" (func $read_register (param i64 i64)))
  (import "env" "register_len" (func $register_len (param i64) (result i64)))
  (import "env" "value_return" (func $value_return (param i64 i64)))
  (import "env" "panic_utf8" (func $panic_utf8 (param i64 i64)))
  (memory (export "memory") 1)
  (data (i32.const 0) "s")
  (data (i32.const 128) "migration expected v1 state")
  (data (i32.const 160) "state too short: expected v2")
  (func (export "migrate")
    (local $len i64)
    (local $count i64)
    i64.const 1 i64.const 0 i64.const 0
    call $storage_read
    drop
    i64.const 0
    call $register_len
    local.set $len
    local.get $len i64.const 8 i64.ne
    if
      i64.const 25 i64.const 128
      call $panic_utf8
    end
    i64.const 0 i64.const 32
    call $read_register
    i32.const 32
    i64.load align=8
    local.set $count
    ;; SEEDED BUG: v2 migration writes only the old 8-byte layout.
    i64.const 1 i64.const 0 i64.const 8 i64.const 32 i64.const 0
    call $storage_write
    drop)
  (func (export "increment")
    (local $len i64)
    (local $version i64)
    (local $count i64)
    i64.const 1 i64.const 0 i64.const 0
    call $storage_read
    drop
    i64.const 0
    call $register_len
    local.set $len
    local.get $len i64.const 16 i64.ne
    if
      i64.const 29 i64.const 160
      call $panic_utf8
    end
    i64.const 0 i64.const 32
    call $read_register
    i32.const 32
    i64.load align=8
    local.set $version
    local.get $version i64.const 2 i64.ne
    if
      i64.const 29 i64.const 160
      call $panic_utf8
    end
    i32.const 40
    i64.load align=8
    local.set $count
    local.get $count i64.const 1 i64.add
    local.set $count
    i32.const 40
    local.get $count
    i64.store align=8
    i64.const 1 i64.const 0 i64.const 16 i64.const 32 i64.const 0
    call $storage_write
    drop)
  (func (export "get")
    (local $len i64)
    (local $version i64)
    i64.const 1 i64.const 0 i64.const 0
    call $storage_read
    drop
    i64.const 0
    call $register_len
    local.set $len
    local.get $len i64.const 16 i64.ne
    if
      i64.const 29 i64.const 160
      call $panic_utf8
    end
    i64.const 0 i64.const 32
    call $read_register
    i32.const 32
    i64.load align=8
    local.set $version
    local.get $version i64.const 2 i64.ne
    if
      i64.const 29 i64.const 160
      call $panic_utf8
    end
    i64.const 8
    i64.const 40
    call $value_return)
)
