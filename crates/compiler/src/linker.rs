//! Module lowering and execution checkpoints consume one semantic linking plan.
use oxc_allocator::{Allocator, ArenaVec, TakeIn};
use oxc_ast::{ast::*, builder::AstBuilder};
use oxc_ast_visit::{VisitMut, walk_mut};
use oxc_semantic::Scoping;
use oxc_span::{GetSpan, SPAN, Span};
use oxc_syntax::{number::NumberBase, operator::UnaryOperator, scope::ScopeFlags};

use crate::output::{CompileError, Metadata};
mod plan;
use plan::{ExportValue, ImportBinding};
pub(crate) use plan::{ModulePlan, Names};

pub(super) struct ModuleLink {
    pub prefix: String,
    pub prefix_lines: u32,
    pub metadata: Metadata,
}

pub(super) fn link_module<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    scoping: &Scoping,
    plan: ModulePlan<'a>,
) -> Result<ModuleLink, CompileError> {
    let mut linker = Linker {
        a: allocator,
        ast: AstBuilder::new(allocator),
        scoping,
        plan,
        function_depth: 0,
        error: None,
    };
    linker.lower_modules(program);
    linker.visit_program(program);
    if let Some(error) = linker.error {
        return Err(error.into());
    }
    Ok(linker.plan.finish())
}

struct Linker<'a, 's> {
    a: &'a Allocator,
    ast: AstBuilder<'a>,
    scoping: &'s Scoping,
    plan: ModulePlan<'a>,
    function_depth: usize,
    error: Option<String>,
}

impl<'a> Linker<'a, '_> {
    fn identifier(&self, span: Span, name: &'a str) -> Expression<'a> {
        Expression::new_identifier(span, name, &self.ast)
    }

    fn member(&self, span: Span, object: Expression<'a>, name: &'static str) -> Expression<'a> {
        Expression::new_static_member_expression(
            span,
            object,
            IdentifierName::new(span, name, &self.ast),
            false,
            &self.ast,
        )
    }

    fn call(
        &self,
        span: Span,
        callee: Expression<'a>,
        args: ArenaVec<'a, Argument<'a>>,
    ) -> Expression<'a> {
        Expression::new_call_expression(span, callee, None, args, false, &self.ast)
    }

    fn string(&self, span: Span, value: &'a str) -> Expression<'a> {
        Expression::new_string_literal(span, value, None, &self.ast)
    }

    fn binding(&self, id: &IdentifierReference<'a>) -> Option<ImportBinding> {
        self.scoping
            .get_reference(id.reference_id.get()?)
            .symbol_id()
            .and_then(|symbol| self.plan.bindings.get(&symbol).copied())
    }

    fn bind(&mut self, id: &BindingIdentifier<'a>, binding: ImportBinding) {
        self.plan.bind(
            id.symbol_id.get().expect("semantic binding"),
            id.name.as_str(),
            binding,
        );
    }

    fn imported_value(&self, span: Span, binding: ImportBinding) -> Expression<'a> {
        let dep = &self.plan.dependencies[binding.dependency];
        let value = if let Some(slot) = binding.slot {
            let slot = self.identifier(span, dep.slots[slot].variable);
            self.call(
                span,
                self.member(span, slot, "read"),
                ArenaVec::new_in(&self.ast),
            )
        } else {
            self.member(span, self.identifier(span, dep.variable), "namespace")
        };
        // Imported calls must not acquire the slot or namespace as their receiver.
        let zero = Expression::new_numeric_literal(span, 0.0, None, NumberBase::Decimal, &self.ast);
        Expression::new_sequence_expression(
            span,
            ArenaVec::from_array_in([zero, value], &self.ast),
            &self.ast,
        )
    }

    fn global_arguments(&self, id: &IdentifierReference<'a>) -> bool {
        id.name == "arguments"
            && self.function_depth == 0
            && id
                .reference_id
                .get()
                .is_some_and(|r| self.scoping.get_reference(r).symbol_id().is_none())
    }

    fn arguments(&self, span: Span, type_of: bool) -> Expression<'a> {
        let mut args = ArenaVec::new_in(&self.ast);
        args.push(self.string(span, "arguments").into());
        if type_of {
            args.push(Expression::new_boolean_literal(span, true, &self.ast).into());
        }
        self.call(
            span,
            self.member(span, self.identifier(span, self.plan.context), "global"),
            args,
        )
    }

    fn checkpoint(&self) -> Expression<'a> {
        self.call(
            SPAN,
            self.identifier(SPAN, self.plan.checkpoint.expect("budgeted module")),
            ArenaVec::new_in(&self.ast),
        )
    }

    fn guard(&self) -> Statement<'a> {
        Statement::new_expression_statement(SPAN, self.checkpoint(), &self.ast)
    }

    fn guard_body(&self, body: &mut Statement<'a>) {
        if self.plan.checkpoint.is_none() {
            return;
        }
        if let Statement::BlockStatement(block) = body {
            block.body.insert(0, self.guard());
        } else {
            let old = body.take_in(&self.ast);
            *body = Statement::new_block_statement(
                SPAN,
                ArenaVec::from_array_in([self.guard(), old], &self.ast),
                &self.ast,
            );
        }
    }

    fn declarations(&mut self, declaration: &Declaration<'a>) {
        match declaration {
            Declaration::VariableDeclaration(d) => {
                for item in &d.declarations {
                    for id in item.id.get_binding_identifiers() {
                        self.plan.exports.push((
                            id.name.to_string(),
                            ExportValue::Local(self.a.alloc_str(id.name.as_str())),
                        ));
                    }
                }
            }
            Declaration::FunctionDeclaration(d) => {
                if let Some(id) = &d.id {
                    self.plan.exports.push((
                        id.name.to_string(),
                        ExportValue::Local(self.a.alloc_str(id.name.as_str())),
                    ));
                }
            }
            Declaration::ClassDeclaration(d) => {
                if let Some(id) = &d.id {
                    self.plan.exports.push((
                        id.name.to_string(),
                        ExportValue::Local(self.a.alloc_str(id.name.as_str())),
                    ));
                }
            }
            _ => {
                self.error = Some("Unsupported remaining TS declaration".into());
            }
        }
    }

    fn lower_import(&mut self, d: &ImportDeclaration<'a>) {
        if d.with_clause.is_some() || d.phase.is_some() {
            self.error = Some("import attributes/phases are unsupported".into());
        }
        let index = self
            .plan
            .dependency(d.source.value.as_str().unwrap_or("\u{fffd}"));
        if d.specifiers
            .as_ref()
            .is_none_or(|specifiers| specifiers.is_empty())
        {
            self.plan.dependencies[index].side_effect = true;
        }
        if let Some(specifiers) = &d.specifiers {
            for spec in specifiers {
                match spec {
                    ImportDeclarationSpecifier::ImportSpecifier(s) => {
                        let value = self.plan.imported(index, Some(&s.imported.name()));
                        self.bind(&s.local, value);
                    }
                    ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => {
                        let value = self.plan.imported(index, Some("default"));
                        self.bind(&s.local, value);
                    }
                    ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => {
                        let value = self.plan.imported(index, None);
                        self.bind(&s.local, value);
                    }
                }
            }
        }
    }

    fn lower_default(&mut self, d: ExportDefaultDeclaration<'a>, program: &mut Program<'a>) {
        let local = self
            .plan
            .names
            .fresh(format!("{}_default", self.plan.context));
        match d.declaration {
            ExportDefaultDeclarationKind::FunctionDeclaration(mut f) => {
                if f.id.is_none() {
                    f.id = Some(BindingIdentifier::new(
                        SPAN,
                        local,
                        &AstBuilder::new(self.a),
                    ));
                }
                self.plan.exports.push((
                    "default".into(),
                    ExportValue::Local(self.a.alloc_str(f.id.as_ref().unwrap().name.as_str())),
                ));
                program.body.push(Statement::FunctionDeclaration(f));
            }
            ExportDefaultDeclarationKind::ClassDeclaration(c) if c.id.is_some() => {
                self.plan.exports.push((
                    "default".into(),
                    ExportValue::Local(self.a.alloc_str(c.id.as_ref().unwrap().name.as_str())),
                ));
                program.body.push(Statement::ClassDeclaration(c));
            }
            value => {
                let value = match value {
                    ExportDefaultDeclarationKind::ClassDeclaration(mut c) => {
                        c.r#type = ClassType::ClassExpression;
                        Expression::ClassExpression(c)
                    }
                    other => other.into_expression(),
                };
                let declaration = VariableDeclarator::new(
                    SPAN,
                    BindingPattern::new_binding_identifier(SPAN, local, &self.ast),
                    None,
                    Some(value),
                    false,
                    &self.ast,
                );
                program.body.push(Statement::new_variable_declaration(
                    SPAN,
                    VariableDeclarationKind::Const,
                    ArenaVec::from_array_in([declaration], &self.ast),
                    false,
                    &self.ast,
                ));
                self.plan
                    .exports
                    .push(("default".into(), ExportValue::Local(local)));
            }
        }
    }

    fn lower_modules(&mut self, program: &mut Program<'a>) {
        let old = program.body.take_in(&self.a);
        for item in old {
            match item {
                Statement::ImportDeclaration(d) => self.lower_import(&d),
                Statement::ExportDeclaration(d) => {
                    let d = d.unbox();
                    self.declarations(&d.declaration);
                    program.body.push(d.declaration.into());
                }
                Statement::ExportNamedDeclaration(d) => {
                    for s in &d.specifiers {
                        self.plan.exports.push((
                            s.exported.name().to_string(),
                            ExportValue::Local(self.a.alloc_str(s.local.name().as_str())),
                        ));
                    }
                }
                Statement::ExportFromDeclaration(d) => {
                    if d.with_clause.is_some() {
                        self.error = Some("export attributes are unsupported".into());
                    }
                    let index = self
                        .plan
                        .dependency(d.source.value.as_str().unwrap_or("\u{fffd}"));
                    for s in &d.specifiers {
                        let value = self.plan.imported(index, Some(&s.local.name()));
                        self.plan
                            .exports
                            .push((s.exported.name().to_string(), ExportValue::Import(value)));
                    }
                }
                Statement::ExportAllDeclaration(d) => {
                    if d.with_clause.is_some() {
                        self.error = Some("export attributes are unsupported".into());
                    }
                    let index = self
                        .plan
                        .dependency(d.source.value.as_str().unwrap_or("\u{fffd}"));
                    let value = self.plan.imported(index, None);
                    if let Some(name) = &d.exported {
                        self.plan
                            .exports
                            .push((name.name().to_string(), ExportValue::Import(value)));
                    } else {
                        self.plan.stars.push(value);
                    }
                }
                Statement::ExportDefaultDeclaration(d) => self.lower_default(d.unbox(), program),
                other => program.body.push(other),
            }
        }
    }
}

impl<'a> VisitMut<'a> for Linker<'a, '_> {
    fn visit_expression(&mut self, node: &mut Expression<'a>) {
        let span = node.span();
        let replacement = match node {
            Expression::Identifier(id) => self
                .binding(id)
                .map(|binding| self.imported_value(span, binding))
                .or_else(|| {
                    self.global_arguments(id)
                        .then(|| self.arguments(span, false))
                }),
            Expression::UnaryExpression(u) if u.operator == UnaryOperator::Typeof => {
                match &u.argument {
                    Expression::Identifier(id) if self.global_arguments(id) => {
                        Some(self.arguments(span, true))
                    }
                    _ => None,
                }
            }
            Expression::ImportMeta(_) => {
                Some(self.member(span, self.identifier(span, self.plan.context), "meta"))
            }
            Expression::ImportExpression(i) => {
                if i.options.is_some() || i.phase.is_some() {
                    self.error = Some("dynamic import options are unsupported".into());
                }
                if let Expression::StringLiteral(s) = &i.source {
                    let name = s.value.as_str().unwrap_or("\u{fffd}");
                    if !self.plan.dynamic.iter().any(|value| value == name) {
                        self.plan.dynamic.push(name.to_owned());
                    }
                    let name = self.string(span, self.a.alloc_str(name));
                    Some(self.call(
                        span,
                        self.member(
                            span,
                            self.identifier(span, self.plan.context),
                            "importDynamic",
                        ),
                        ArenaVec::from_array_in([name.into()], &self.ast),
                    ))
                } else {
                    self.error = Some("dynamic import requires a literal specifier".into());
                    None
                }
            }
            Expression::StaticMemberExpression(m) if m.property.name == "NODE_ENV" => {
                if let Expression::StaticMemberExpression(env) = &m.object {
                    if env.property.name == "env"
                        && matches!(&env.object, Expression::Identifier(i) if i.name == "process" && i.reference_id.get().is_some_and(|r| self.scoping.get_reference(r).symbol_id().is_none()))
                    {
                        Some(self.string(span, "development"))
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
            _ => None,
        };
        if let Some(replacement) = replacement {
            *node = replacement;
        } else {
            walk_mut::walk_expression(self, node);
        }
    }

    fn visit_identifier_reference(&mut self, id: &mut IdentifierReference<'a>) {
        if let Some(r) = id.reference_id.get()
            && self.scoping.get_reference(r).is_write()
            && self.binding(id).is_some()
        {
            self.error = Some(format!("Cannot assign to import binding: {}", id.name));
        }
    }

    fn visit_object_property(&mut self, node: &mut ObjectProperty<'a>) {
        if node.shorthand
            && matches!(&node.value, Expression::Identifier(id) if self.binding(id).is_some() || self.global_arguments(id))
        {
            node.shorthand = false;
        }
        walk_mut::walk_object_property(self, node);
    }

    fn visit_function(&mut self, node: &mut Function<'a>, flags: ScopeFlags) {
        self.function_depth += 1;
        walk_mut::walk_function(self, node, flags);
        self.function_depth -= 1;
    }

    fn visit_function_body(&mut self, body: &mut FunctionBody<'a>) {
        walk_mut::walk_function_body(self, body);
        if self.plan.checkpoint.is_some() {
            body.statements.insert(0, self.guard());
        }
    }

    fn visit_arrow_function_expression(&mut self, node: &mut ArrowFunctionExpression<'a>) {
        walk_mut::walk_arrow_function_expression(self, node);
        if self.plan.checkpoint.is_some()
            && !matches!(node.body, ArrowFunctionBody::FunctionBody(_))
        {
            let old = node.body.take_in(&self.a).into_expression();
            node.body = Expression::new_sequence_expression(
                SPAN,
                ArenaVec::from_array_in([self.checkpoint(), old], &self.ast),
                &self.ast,
            )
            .into();
        }
    }

    fn visit_catch_clause(&mut self, node: &mut CatchClause<'a>) {
        walk_mut::walk_catch_clause(self, node);
        if self.plan.checkpoint.is_some() {
            node.body.body.insert(0, self.guard());
        }
    }

    fn visit_while_statement(&mut self, node: &mut WhileStatement<'a>) {
        walk_mut::walk_while_statement(self, node);
        self.guard_body(&mut node.body);
    }

    fn visit_do_while_statement(&mut self, node: &mut DoWhileStatement<'a>) {
        walk_mut::walk_do_while_statement(self, node);
        self.guard_body(&mut node.body);
    }

    fn visit_for_statement(&mut self, node: &mut ForStatement<'a>) {
        walk_mut::walk_for_statement(self, node);
        self.guard_body(&mut node.body);
    }

    fn visit_for_in_statement(&mut self, node: &mut ForInStatement<'a>) {
        walk_mut::walk_for_in_statement(self, node);
        self.guard_body(&mut node.body);
    }

    fn visit_for_of_statement(&mut self, node: &mut ForOfStatement<'a>) {
        walk_mut::walk_for_of_statement(self, node);
        self.guard_body(&mut node.body);
    }
}
