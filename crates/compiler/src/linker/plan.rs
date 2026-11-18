use std::collections::{HashMap, HashSet};
use std::fmt::{Arguments, Write};

use oxc_allocator::Allocator;
use oxc_semantic::Scoping;
use oxc_syntax::symbol::SymbolId;

use crate::output::Metadata;

const PREFIX: &str = "__playground_";

#[derive(Default)]
struct Prelude {
    code: String,
    lines: u32,
}

impl Prelude {
    fn end_line(&mut self) {
        self.code.push('\n');
        self.lines += 1;
    }

    fn line(&mut self, args: Arguments<'_>) {
        self.code.write_fmt(args).unwrap();
        self.end_line();
    }

    fn quoted(&mut self, value: &str) {
        let json = serde_json::to_string(value).unwrap();
        // A JSON string may contain literal ECMAScript line or paragraph separators.
        for part in json.split_inclusive(['\u{2028}', '\u{2029}']) {
            if let Some(head) = part.strip_suffix('\u{2028}') {
                self.code.push_str(head);
                self.code.push_str("\\u2028");
            } else if let Some(head) = part.strip_suffix('\u{2029}') {
                self.code.push_str(head);
                self.code.push_str("\\u2029");
            } else {
                self.code.push_str(part);
            }
        }
    }
}

pub(crate) struct Names<'a> {
    allocator: &'a Allocator,
    occupied: HashSet<&'a str>,
}

impl<'a> Names<'a> {
    pub fn new(allocator: &'a Allocator, scoping: &Scoping) -> Self {
        let mut names = Self {
            allocator,
            occupied: HashSet::new(),
        };
        names.include(scoping);
        names
    }

    pub fn include(&mut self, scoping: &Scoping) {
        for name in scoping.symbol_names().chain(
            scoping
                .root_unresolved_references()
                .keys()
                .map(|name| name.as_str()),
        ) {
            // Every generated name uses this namespace. Other user names cannot collide.
            if name.starts_with(PREFIX) && !self.occupied.contains(name) {
                self.occupied.insert(self.allocator.alloc_str(name));
            }
        }
    }

    pub fn fresh(&mut self, mut candidate: String) -> &'a str {
        debug_assert!(candidate.starts_with(PREFIX));
        while self.occupied.contains(candidate.as_str()) {
            candidate.push('_');
        }
        let name = self.allocator.alloc_str(&candidate);
        self.occupied.insert(name);
        name
    }
}

#[derive(Clone, Copy)]
pub(super) struct ImportBinding {
    pub dependency: usize,
    pub slot: Option<usize>,
}

#[derive(Clone, Copy)]
pub(super) enum ExportValue<'a> {
    Local(&'a str),
    Import(ImportBinding),
}

pub(super) struct ImportSlot<'a> {
    pub imported: &'a str,
    pub variable: &'a str,
}

pub(super) struct Dependency<'a> {
    pub source: &'a str,
    pub variable: &'a str,
    pub slots: Vec<ImportSlot<'a>>,
    slot_index: HashMap<&'a str, usize>,
    pub namespace: bool,
    pub side_effect: bool,
}

pub(crate) struct ModulePlan<'a> {
    pub(super) names: Names<'a>,
    pub(super) context: &'a str,
    pub(super) checkpoint: Option<&'a str>,
    register: &'a str,
    signature: &'a str,
    pub(super) bindings: HashMap<SymbolId, ImportBinding>,
    named: HashMap<&'a str, ImportBinding>,
    pub(super) dependencies: Vec<Dependency<'a>>,
    dependency_index: HashMap<&'a str, usize>,
    pub(super) exports: Vec<(String, ExportValue<'a>)>,
    pub(super) stars: Vec<ImportBinding>,
    pub(super) dynamic: Vec<String>,
}

impl<'a> ModulePlan<'a> {
    pub fn new(
        mut names: Names<'a>,
        scoping: &Scoping,
        budgeted: bool,
        register: &'a str,
        signature: &'a str,
    ) -> Self {
        names.include(scoping);
        let context = names.fresh("__playground_module".into());
        let checkpoint = budgeted.then(|| names.fresh("__playground_checkpoint".into()));
        Self {
            names,
            context,
            checkpoint,
            register,
            signature,
            bindings: HashMap::new(),
            named: HashMap::new(),
            dependencies: Vec::new(),
            dependency_index: HashMap::new(),
            exports: Vec::new(),
            stars: Vec::new(),
            dynamic: Vec::new(),
        }
    }

    pub fn dependency(&mut self, source: &str) -> usize {
        if let Some(&index) = self.dependency_index.get(source) {
            return index;
        }
        let source = self.names.allocator.alloc_str(source);
        let index = self.dependencies.len();
        let variable = self.names.fresh(format!("{}_import{index}", self.context));
        self.dependencies.push(Dependency {
            source,
            variable,
            slots: Vec::new(),
            slot_index: HashMap::new(),
            namespace: false,
            side_effect: false,
        });
        self.dependency_index.insert(source, index);
        index
    }

    pub(super) fn imported(&mut self, dependency: usize, name: Option<&str>) -> ImportBinding {
        let dep = &mut self.dependencies[dependency];
        let slot = name.map(|name| {
            if let Some(&slot) = dep.slot_index.get(name) {
                return slot;
            }
            let slot = dep.slots.len();
            let imported = self.names.allocator.alloc_str(name);
            let variable = self.names.fresh(format!("{}_slot{slot}", dep.variable));
            dep.slots.push(ImportSlot { imported, variable });
            dep.slot_index.insert(imported, slot);
            slot
        });
        if slot.is_none() {
            dep.namespace = true;
        }
        ImportBinding { dependency, slot }
    }

    pub(super) fn bind(&mut self, symbol: SymbolId, name: &str, binding: ImportBinding) {
        self.bindings.insert(symbol, binding);
        self.named
            .insert(self.names.allocator.alloc_str(name), binding);
    }

    fn write_value(&self, output: &mut String, value: ExportValue<'a>) {
        match value {
            ExportValue::Local(name) => {
                if let Some(&binding) = self.named.get(name) {
                    self.write_value(output, ExportValue::Import(binding));
                } else {
                    output.push_str(name);
                }
            }
            ExportValue::Import(binding) => {
                let dep = &self.dependencies[binding.dependency];
                if let Some(slot) = binding.slot {
                    write!(output, "{}.read()", dep.slots[slot].variable).unwrap();
                } else {
                    write!(output, "{}.namespace", dep.variable).unwrap();
                }
            }
        }
    }

    pub(super) fn finish(self) -> super::ModuleLink {
        let c = self.context;
        let mut prefix = Prelude::default();
        prefix.line(format_args!("async function({c}) {{"));
        prefix.line(format_args!("\"use strict\";"));
        if let Some(checkpoint) = self.checkpoint {
            prefix.line(format_args!("const {checkpoint} = {c}.checkpoint;"));
            prefix.line(format_args!("{checkpoint}();"));
        }
        prefix.line(format_args!(
            "const {} = {c}.register, {} = {c}.signature;",
            self.register, self.signature
        ));
        for (name, value) in &self.exports {
            write!(prefix.code, "{c}.export(").unwrap();
            prefix.quoted(name);
            prefix.code.push_str(", () => ");
            self.write_value(&mut prefix.code, *value);
            prefix.line(format_args!(");"));
        }
        for dep in &self.dependencies {
            write!(
                prefix.code,
                "const {} = await {c}.importBindings(",
                dep.variable
            )
            .unwrap();
            prefix.quoted(dep.source);
            prefix.code.push_str(", [");
            for (index, slot) in dep.slots.iter().enumerate() {
                if index > 0 {
                    prefix.code.push(',');
                }
                prefix.quoted(slot.imported);
            }
            prefix.line(format_args!("], {}, {});", dep.namespace, dep.side_effect));
            for (index, slot) in dep.slots.iter().enumerate() {
                prefix.line(format_args!(
                    "const {} = {}.slots[{index}];",
                    slot.variable, dep.variable
                ));
            }
        }
        for &binding in &self.stars {
            write!(prefix.code, "{c}.exportAll(").unwrap();
            self.write_value(&mut prefix.code, ExportValue::Import(binding));
            prefix.line(format_args!(");"));
        }
        let metadata = Metadata {
            specifiers: self
                .dependencies
                .into_iter()
                .map(|dep| dep.source.to_owned())
                .collect(),
            dynamic: self.dynamic,
        };
        super::ModuleLink {
            prefix: prefix.code,
            prefix_lines: prefix.lines,
            metadata,
        }
    }
}
