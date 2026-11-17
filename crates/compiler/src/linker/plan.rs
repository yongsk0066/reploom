use std::collections::{HashMap, HashSet};
use std::fmt::Write;

use oxc_allocator::Allocator;
use oxc_semantic::Scoping;
use oxc_syntax::symbol::SymbolId;

use crate::output::Metadata;

const PREFIX: &str = "__playground_";

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

    pub fn finish(self) -> (String, Metadata) {
        let c = self.context;
        let mut prefix = format!("async function({c}) {{\n\"use strict\";\n");
        if let Some(checkpoint) = self.checkpoint {
            writeln!(
                prefix,
                "const {checkpoint} = {c}.checkpoint;\n{checkpoint}();"
            )
            .unwrap();
        }
        writeln!(
            prefix,
            "const {} = {c}.register, {} = {c}.signature;",
            self.register, self.signature
        )
        .unwrap();
        for (name, value) in &self.exports {
            write!(
                prefix,
                "{c}.export({}, () => ",
                serde_json::to_string(name).unwrap()
            )
            .unwrap();
            self.write_value(&mut prefix, *value);
            prefix.push_str(");\n");
        }
        for dep in &self.dependencies {
            write!(
                prefix,
                "const {} = await {c}.importBindings({}, [",
                dep.variable,
                serde_json::to_string(dep.source).unwrap()
            )
            .unwrap();
            for (index, slot) in dep.slots.iter().enumerate() {
                if index > 0 {
                    prefix.push(',');
                }
                prefix.push_str(&serde_json::to_string(slot.imported).unwrap());
            }
            writeln!(prefix, "], {}, {});", dep.namespace, dep.side_effect).unwrap();
            for (index, slot) in dep.slots.iter().enumerate() {
                writeln!(
                    prefix,
                    "const {} = {}.slots[{index}];",
                    slot.variable, dep.variable
                )
                .unwrap();
            }
        }
        for &binding in &self.stars {
            write!(prefix, "{c}.exportAll(").unwrap();
            self.write_value(&mut prefix, ExportValue::Import(binding));
            prefix.push_str(");\n");
        }
        let metadata = Metadata {
            specifiers: self
                .dependencies
                .into_iter()
                .map(|dep| dep.source.to_owned())
                .collect(),
            dynamic: self.dynamic,
        };
        (prefix, metadata)
    }
}
