//! The module ABI pass runs on Oxc's transformed AST, before a single codegen.
//! No user AST crosses WASM/JS; each call owns and releases its arena.
use base64::Engine;
use oxc_allocator::Allocator;
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_diagnostics::{Diagnostics, Severity};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{ReactRefreshOptions, TransformOptions, Transformer};
use serde_json::json;
use std::path::Path;
mod linker;
mod output;
mod parser;
use linker::{ModulePlan, Names, link_module};
use output::{Artifact, CompileError, Diagnostic, OwnedResult};

fn check_diagnostics(
    errors: &Diagnostics,
    filename: &str,
    source: &str,
) -> Result<(), CompileError> {
    let errors: Vec<Diagnostic> = errors
        .iter()
        .filter(|error| error.severity != Severity::Warning)
        .map(|error| {
            let offset = error
                .labels
                .first()
                .map_or(0, |label| label.offset() as usize)
                .min(source.len());
            let prefix = &source[..source.floor_char_boundary(offset)];
            let line = prefix.bytes().filter(|b| *b == b'\n').count() + 1;
            let column = prefix.rsplit('\n').next().unwrap().encode_utf16().count();
            Diagnostic {
                text: error.message.to_string(),
                file: filename.into(),
                line: Some(line),
                column: Some(column),
            }
        })
        .collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(CompileError::Diagnostics(errors))
    }
}

fn compile_inner(
    filename: &str,
    source: &str,
    runtime: &str,
    cooperative: bool,
) -> Result<Artifact, CompileError> {
    let allocator = Allocator::default();
    let path = Path::new(filename);
    let source_type = if filename.ends_with(".ts") || filename.ends_with(".tsx") {
        SourceType::tsx()
    } else {
        SourceType::jsx()
    };
    let ret = Parser::new(&allocator, source, source_type)
        .with_options(parser::options())
        .parse();
    check_diagnostics(&ret.diagnostics, filename, source)?;
    safe_point(1, cooperative)?;
    let mut program = ret.program;
    let force_reset = runtime == "react"
        && program.comments.iter().any(|c| {
            source[c.span.start as usize..c.span.end as usize]
                .split_whitespace()
                .collect::<Vec<_>>()
                .windows(2)
                .any(|w| w == ["@refresh", "reset"])
        });
    let semantic = SemanticBuilder::new_compiler()
        .with_enum_eval(true)
        .build(&program);
    check_diagnostics(&semantic.diagnostics, filename, source)?;
    safe_point(2, cooperative)?;
    let mut names = Names::new(&allocator, semantic.semantic.scoping());
    let register = names.fresh("__playground_register".into());
    let signature = names.fresh("__playground_signature".into());
    let mut options = TransformOptions::from_target("es2022").map_err(|e| format!("{e:?}"))?;
    options.jsx.development = true;
    options.jsx.conform();
    if runtime == "react" {
        options.jsx.refresh = Some(ReactRefreshOptions {
            refresh_reg: register.to_owned(),
            refresh_sig: signature.to_owned(),
            emit_full_signatures: true,
        });
    }
    let ret = Transformer::new(&allocator, path, &options)
        .build_with_scoping(semantic.semantic.into_scoping(), &mut program);
    check_diagnostics(&ret.diagnostics, filename, source)?;
    safe_point(3, cooperative)?;
    let plan = ModulePlan::new(
        names,
        &ret.scoping,
        runtime != "compute",
        register,
        signature,
    );
    let linked = link_module(&allocator, &mut program, &ret.scoping, plan)?;
    drop(ret);
    safe_point(4, cooperative)?;
    program.hashbang = None;
    let generated = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: Some(path.to_path_buf()),
            ..Default::default()
        })
        .build(&program);
    safe_point(5, cooperative)?;
    let mut prefix = linked.prefix;
    let offset = prefix.bytes().filter(|b| *b == b'\n').count() as u32 + 2;
    let map_json = generated
        .map
        .unwrap()
        .to_json_string_with_generated_line_offset(offset);
    safe_point(6, cooperative)?;
    prefix.reserve(generated.code.len() + 2);
    prefix.push_str(&generated.code);
    prefix.push_str("\n}");
    Ok(Artifact {
        code: prefix,
        map_json,
        metadata: linked.metadata,
        force_reset,
    })
}

pub fn compile(filename: &str, source: &str, runtime: &str) -> String {
    match compile_inner(filename, source, runtime, false) {
        // The CLI retains its JSON contract; the browser consumes raw map bytes.
        Ok(value) => json!({"ok":true,"artifact": {
            "code": value.code,
            "sourceMap": "data:application/json;base64,".to_owned()
                + &base64::engine::general_purpose::STANDARD.encode(value.map_json.as_bytes()),
            "specifiers": value.metadata.specifiers,
            "dynamic": value.metadata.dynamic,
            "forceReset": value.force_reset,
        }})
        .to_string(),
        Err(error) => json!({"ok":false,"error":error.diagnostics(filename)}).to_string(),
    }
}

// The host may suspend only here, between completed compiler stages. The arena
// stays on this call's stack. The host forbids reentry into the same Instance.
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "playground")]
unsafe extern "C" {
    fn checkpoint(phase: u32) -> u32;
}

fn safe_point(phase: u32, cooperative: bool) -> Result<(), CompileError> {
    if !cooperative {
        return Ok(());
    }
    #[cfg(target_arch = "wasm32")]
    if unsafe { checkpoint(phase) } != 0 {
        return Err(CompileError::Cancelled);
    }
    #[cfg(not(target_arch = "wasm32"))]
    let _ = phase;
    Ok(())
}

// Input allocations and the returned result handle have separate owners.
// Only this trusted host calls the ABI; pointers are not accepted from projects.
#[unsafe(no_mangle)]
pub extern "C" fn abi_version() -> u32 {
    3
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(length: u32) -> *mut u8 {
    let buffer = vec![0u8; length as usize].into_boxed_slice();
    Box::into_raw(buffer) as *mut u8
}

/// Releases an input allocation owned by the host.
///
/// # Safety
/// `ptr` must be the live pointer returned by `alloc(length)` in this instance.
/// The length must match, and the allocation must not be used or freed again.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, length: u32) {
    unsafe {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            ptr,
            length as usize,
        )));
    }
}

/// Compiles host-owned UTF-8 input into a separately owned result handle.
///
/// # Safety
/// Both pointer/length pairs must describe initialized, valid UTF-8 allocations
/// in this instance. They must remain live and immutable until the call returns,
/// including while a cooperative checkpoint suspends it. The host must prevent
/// reentry into this instance and release the result exactly once with `free_result`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn compile_module(
    file: *const u8,
    file_len: u32,
    source: *const u8,
    source_len: u32,
    runtime: u32,
    cooperative: u32,
) -> *mut OwnedResult {
    let file = unsafe {
        std::str::from_utf8_unchecked(std::slice::from_raw_parts(file, file_len as usize))
    };
    let source = unsafe {
        std::str::from_utf8_unchecked(std::slice::from_raw_parts(source, source_len as usize))
    };
    let result = compile_inner(
        file,
        source,
        match runtime {
            0 => "react",
            1 => "dom",
            _ => "compute",
        },
        cooperative != 0,
    );
    OwnedResult::new(result, file)
}
