;; Compiler failure fixture: cleanup also traps if the host incorrectly reenters.
(module
  (memory (export "memory") 1)
  (func (export "abi_version") (result i32) (i32.const 3))
  (func (export "alloc") (param i32) (result i32) (i32.const 16))
  (func (export "dealloc") (param i32 i32) (unreachable))
  (func (export "free_result") (param i32) (unreachable))
  (func (export "compile_module") (param i32 i32 i32 i32 i32 i32) (result i32) (unreachable))
)
