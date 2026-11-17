//! Compiler result ownership. Large strings cross WASM without JSON wrapping.
use serde::Serialize;

#[derive(Serialize)]
pub struct Metadata {
    pub specifiers: Vec<String>,
    pub dynamic: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub code: String,
    pub map_json: String,
    #[serde(flatten)]
    pub metadata: Metadata,
    pub force_reset: bool,
}

#[derive(Serialize)]
pub struct Diagnostic {
    pub text: String,
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
}

pub enum CompileError {
    Diagnostics(Vec<Diagnostic>),
    Message(String),
    Cancelled,
}

impl From<String> for CompileError {
    fn from(message: String) -> Self {
        Self::Message(message)
    }
}

impl CompileError {
    pub fn diagnostics(self, file: &str) -> Vec<Diagnostic> {
        match self {
            Self::Diagnostics(diagnostics) => diagnostics,
            Self::Message(text) => vec![Diagnostic {
                text,
                file: file.into(),
                line: None,
                column: None,
            }],
            Self::Cancelled => vec![],
        }
    }
}

// wasm32 ABI 3: eight little-endian words. The map slice is raw UTF-8 JSON,
// not a base64 data URL. The remaining Rust fields are opaque.
// The returned handle owns all three strings until free_result(handle).
#[repr(C)]
pub struct OwnedResult {
    status: u32, // 0 success, 1 diagnostics, 2 cancelled
    flags: u32,  // bit 0: refresh reset
    code_ptr: *const u8,
    code_len: u32,
    map_ptr: *const u8,
    map_len: u32,
    metadata_ptr: *const u8,
    metadata_len: u32,
    code: String,
    map_json: String,
    metadata: String,
}

impl OwnedResult {
    pub fn new(result: Result<Artifact, CompileError>, file: &str) -> *mut Self {
        let (status, flags, code, map_json, metadata) = match result {
            Ok(artifact) => (
                0,
                u32::from(artifact.force_reset),
                artifact.code,
                artifact.map_json,
                serde_json::to_string(&artifact.metadata).unwrap(),
            ),
            Err(CompileError::Cancelled) => (2, 0, String::new(), String::new(), String::new()),
            Err(error) => (
                1,
                0,
                String::new(),
                String::new(),
                serde_json::to_string(&error.diagnostics(file)).unwrap(),
            ),
        };
        Box::into_raw(Box::new(Self {
            status,
            flags,
            code_ptr: code.as_ptr(),
            code_len: code.len() as u32,
            map_ptr: map_json.as_ptr(),
            map_len: map_json.len() as u32,
            metadata_ptr: metadata.as_ptr(),
            metadata_len: metadata.len() as u32,
            code,
            map_json,
            metadata,
        }))
    }
}

/// Only the trusted host may pass a live handle returned by compile_module.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn free_result(result: *mut OwnedResult) {
    unsafe { drop(Box::from_raw(result)) };
}

// Check the wire layout at compilation, without relying on Rust's String layout.
#[cfg(target_arch = "wasm32")]
const _: () = {
    assert!(std::mem::offset_of!(OwnedResult, code_ptr) == 8);
    assert!(std::mem::offset_of!(OwnedResult, metadata_len) == 28);
    assert!(std::mem::offset_of!(OwnedResult, code) == 32);
};
