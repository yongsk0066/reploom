;; ABI 3 invalid slice: the host must retire this Instance, never free the handle.
(module
  (memory (export "memory") 1)
  (data (i32.const 256) "\00\00\00\00\00\00\00\00\fa\ff\00\00\28\00\00\00")
  (func (export "abi_version") (result i32) (i32.const 3))
  (func (export "alloc") (param i32) (result i32) (i32.const 16))
  (func (export "dealloc") (param i32 i32) (unreachable))
  (func (export "free_result") (param i32) (unreachable))
  (func (export "compile_module") (param i32 i32 i32 i32 i32 i32) (result i32) (i32.const 256))
)
