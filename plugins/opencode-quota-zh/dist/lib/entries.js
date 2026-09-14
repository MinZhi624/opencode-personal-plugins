export function isValueEntry(e) {
    return e.kind === "value";
}
export function isQuantityEntry(e) {
    return e.kind === "quantity";
}
export function isBooleanEntry(e) {
    return e.kind === "boolean";
}
export function isPercentEntry(e) {
    return e.kind === undefined || e.kind === "percent";
}
export function cloneAccountingUnit(unit) {
    return { ...unit };
}
export function cloneAccountingQuantity(quantity) {
    return { decimal: quantity.decimal, unit: cloneAccountingUnit(quantity.unit) };
}
export function cloneAccountingSemantic(semantic) {
    return { metric: { ...semantic.metric }, prominence: semantic.prominence };
}
export function cloneAccountingBasisFact(fact) {
    return { quantity: cloneAccountingQuantity(fact.quantity), authority: fact.authority };
}
export function cloneAccountingPercentageBasis(basis) {
    return {
        ...(basis.used ? { used: cloneAccountingBasisFact(basis.used) } : {}),
        ...(basis.limit ? { limit: cloneAccountingBasisFact(basis.limit) } : {}),
        ...(basis.remaining ? { remaining: cloneAccountingBasisFact(basis.remaining) } : {}),
    };
}
export function cloneQuotaToastEntry(entry) {
    return {
        ...entry,
        accounting: { ...entry.accounting },
        ...(entry.semantic ? { semantic: cloneAccountingSemantic(entry.semantic) } : {}),
        ...(isPercentEntry(entry) && entry.basis
            ? { basis: cloneAccountingPercentageBasis(entry.basis) }
            : {}),
        ...(isPercentEntry(entry) && entry.fixedWindow
            ? { fixedWindow: { ...entry.fixedWindow } }
            : {}),
        ...(isPercentEntry(entry) && entry.runway ? { runway: { ...entry.runway } } : {}),
        ...(isQuantityEntry(entry) ? { quantity: cloneAccountingQuantity(entry.quantity) } : {}),
    };
}
