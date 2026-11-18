//! Previous revisions can predict reservation sizes. Only counts survive a call.
use oxc_ast::ast::Program;
use oxc_semantic::{SemanticBuilder, SemanticBuilderReturn, Stats};
use oxc_span::GetSpan;
use std::cell::Cell;
use std::hash::{DefaultHasher, Hash, Hasher};

#[derive(Clone, Copy)]
struct Shape {
    source: usize,
    items: usize,
    code_span: u32,
}

impl Shape {
    fn of(program: &Program<'_>) -> Option<Self> {
        let source = program.source_text.len();
        if !(4096..=1_000_000).contains(&source) {
            return None;
        }
        let first = program.body.first()?.span().start;
        let last = program.body.last()?.span().end;
        Some(Self {
            source,
            items: program.body.len(),
            code_span: last - first,
        })
    }

    fn resembles(self, other: Self) -> bool {
        self.source.abs_diff(other.source) <= self.source / 8
            && self.code_span.abs_diff(other.code_span) <= self.code_span / 8
            && self.items.abs_diff(other.items) <= (self.items / 8).max(1)
    }
}

#[derive(Clone, Copy)]
struct Estimate {
    key: u64,
    shape: Shape,
    counts: Stats,
}

// Each WASM instance owns these fixed-size slots. They retain no paths, source or AST.
const SLOTS: usize = 16;
thread_local! {
    static HISTORY: [Cell<Option<Estimate>>; SLOTS] = const { [const { Cell::new(None) }; SLOTS] };
}

pub fn analyze<'a>(file: &str, program: &'a Program<'a>) -> SemanticBuilderReturn<'a> {
    let builder = SemanticBuilder::new_compiler().with_enum_eval(true);
    let Some(shape) = Shape::of(program) else {
        return builder.build(program);
    };
    let mut hash = DefaultHasher::new();
    file.hash(&mut hash);
    let key = hash.finish();
    let slot = key as usize % SLOTS;
    let estimate = HISTORY.with(|history| history[slot].get());
    let result = match estimate {
        Some(old) if old.key == key && shape.resembles(old.shape) => builder.with_stats(old.counts),
        _ => builder,
    }
    .build(program);
    if result.diagnostics.is_empty() {
        let counts = result.semantic.stats();
        HISTORY.with(|history| history[slot].set(Some(Estimate { key, shape, counts })));
    }
    result
}
