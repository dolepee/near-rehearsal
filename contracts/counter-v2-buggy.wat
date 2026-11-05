(module
  (import "env" "storage_read" (func $storage_read (param i64 i64 i64) (result i64)))
  (import "env" "storage_write" (func $storage_write (param i64 i64 i64 i64 i64) (result i64)))
  (import "env" "read_register" (func $read_register (param i64 i64)))
  (import "env" "register_len" (func $register_len (param i64) (result i64)))
  (import "env" "value_return" (func $value_return (param i64 i64)))
  (import "env" "panic_utf8" (func $panic_utf8 (param i64 i64)))
  (memory (export "memory") 1)
  (data (i32.const 0) "counter")
  (data (i32.const 8) "version")
  (data (i32.const 16) "1")
  (data (i32.const 128) "v2 migration missing")
  (data (i32.const 160) "state parse failed")
  (func (export "migrate")
    ;; SEEDED BUG: declares the wrong version, leaving v2 operations gated off.
    i64.const 7 i64.const 8 i64.const 1 i64.const 16 i64.const 0
    call $storage_write
    drop)
  (func (export "incrementCounter")
    (local $len i64)
    (local $i i32)
    (local $n i32)
    (local $acc i64)
    (local $digit i64)
    (local $outlen i64)
    (local $ptr i32)
    ;; require the v2 marker
    i64.const 7 i64.const 8 i64.const 0
    call $storage_read
    drop
    i64.const 0
    call $register_len
    i64.const 1
    i64.ne
    if
      i64.const 20 i64.const 128
      call $panic_utf8
    end
    i64.const 0 i64.const 16
    call $read_register
    i32.const 16
    i32.load8_u
    i32.const 50
    i32.ne
    if
      i64.const 20 i64.const 128
      call $panic_utf8
    end
    ;; read the existing ASCII counter
    i64.const 7 i64.const 0 i64.const 0
    call $storage_read
    drop
    i64.const 0
    call $register_len
    local.set $len
    local.get $len
    i64.eqz
    if
      i64.const 17 i64.const 160
      call $panic_utf8
    end
    i64.const 0 i64.const 32
    call $read_register
    i32.const 0
    local.set $i
    local.get $len
    i32.wrap_i64
    local.set $n
    i64.const 0
    local.set $acc
    block $parsed
      loop $parse
        local.get $i
        local.get $n
        i32.ge_u
        br_if $parsed
        local.get $i
        i32.const 32
        i32.add
        i32.load8_u
        i32.const 48
        i32.sub
        i64.extend_i32_u
        local.set $digit
        local.get $acc
        i64.const 10
        i64.mul
        local.get $digit
        i64.add
        local.set $acc
        local.get $i
        i32.const 1
        i32.add
        local.set $i
        br $parse
      end
    end
    local.get $acc
    i64.const 1
    i64.add
    local.set $acc
    ;; decimal conversion, backwards from address 96
    i32.const 96
    local.set $ptr
    block $digits_done
      loop $digits
        local.get $acc
        i64.eqz
        br_if $digits_done
        local.get $ptr
        i32.const 1
        i32.sub
        local.set $ptr
        local.get $ptr
        local.get $acc
        i64.const 10
        i64.rem_u
        i32.wrap_i64
        i32.const 48
        i32.add
        i32.store8
        local.get $acc
        i64.const 10
        i64.div_u
        local.set $acc
        br $digits
      end
    end
    i32.const 96
    local.get $ptr
    i32.sub
    i64.extend_i32_u
    local.set $outlen
    ;; storage_write(key_len, key_ptr, value_len, value_ptr, register_id)
    i64.const 7
    i64.const 0
    local.get $outlen
    local.get $ptr
    i64.extend_i32_u
    i64.const 0
    call $storage_write
    drop)
  (func (export "getCounter")
    (local $len i64)
    i64.const 7 i64.const 0 i64.const 0
    call $storage_read
    drop
    i64.const 0
    call $register_len
    local.set $len
    i64.const 0 i64.const 32
    call $read_register
    local.get $len
    i64.const 32
    call $value_return)
)
