/**
 * Shared display sanitization for user-visible output.
 *
 * Strips ANSI escape sequences and other control characters so that
 * remote/provider error text cannot inject terminal control codes into
 * toasts or transcript output.
 */
import { cloneAccountingBasisFact, cloneAccountingQuantity, cloneAccountingSemantic, cloneQuotaToastEntry, isPercentEntry, isQuantityEntry, isValueEntry, } from "./entries.js";
// Remove terminal escape sequences (CSI/OSC/DCS/APC/PM/SOS) and other control
// characters except newline/tab so provider text cannot inject terminal actions.
// eslint-disable-next-line no-control-regex
const DISPLAY_ESCAPE_SEQUENCE_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x1B\u0007]*(?:\u0007|\x1B\\)|P[\s\S]*?\x1B\\|_[\s\S]*?\x1B\\|\^[\s\S]*?\x1B\\|X[\s\S]*?\x1B\\|[@-_])/g;
// eslint-disable-next-line no-control-regex
const DISPLAY_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
export function sanitizeDisplayText(text) {
    return text.replace(DISPLAY_ESCAPE_SEQUENCE_RE, "").replace(DISPLAY_CONTROL_RE, "");
}
export function sanitizeSingleLineDisplayText(text) {
    return sanitizeDisplayText(text).replace(/\s+/gu, " ").trim();
}
export function sanitizeDisplaySnippet(text, maxLength) {
    return sanitizeDisplayText(text).slice(0, maxLength);
}
export function sanitizeSingleLineDisplaySnippet(text, maxLength) {
    return sanitizeSingleLineDisplayText(text).slice(0, maxLength);
}
export function sanitizeOptionalDisplayText(value) {
    return typeof value === "string" ? sanitizeDisplayText(value) : undefined;
}
function sanitizeAccountingQuantity(quantity) {
    if (quantity.unit.kind !== "custom")
        return cloneAccountingQuantity(quantity);
    return {
        decimal: quantity.decimal,
        unit: {
            kind: "custom",
            symbol: sanitizeSingleLineDisplayText(quantity.unit.symbol),
        },
    };
}
function sanitizeAccountingSemantic(semantic) {
    const cloned = cloneAccountingSemantic(semantic);
    if (cloned.metric.kind !== "named")
        return cloned;
    return {
        ...cloned,
        metric: {
            kind: "named",
            name: sanitizeSingleLineDisplayText(cloned.metric.name),
        },
    };
}
function sanitizeAccountingBasis(basis) {
    const sanitizeFact = (fact) => ({
        ...cloneAccountingBasisFact(fact),
        quantity: sanitizeAccountingQuantity(fact.quantity),
    });
    return {
        ...(basis.used ? { used: sanitizeFact(basis.used) } : {}),
        ...(basis.limit ? { limit: sanitizeFact(basis.limit) } : {}),
        ...(basis.remaining ? { remaining: sanitizeFact(basis.remaining) } : {}),
    };
}
export function sanitizeQuotaToastEntry(entry) {
    const sanitized = cloneQuotaToastEntry(entry);
    sanitized.name = sanitizeDisplayText(entry.name);
    if (entry.group !== undefined)
        sanitized.group = sanitizeDisplayText(entry.group);
    if (entry.label !== undefined)
        sanitized.label = sanitizeDisplayText(entry.label);
    if (entry.metricLabel !== undefined) {
        sanitized.metricLabel = sanitizeDisplayText(entry.metricLabel);
    }
    if (entry.right !== undefined)
        sanitized.right = sanitizeDisplayText(entry.right);
    if (entry.semantic)
        sanitized.semantic = sanitizeAccountingSemantic(entry.semantic);
    if (isValueEntry(sanitized)) {
        sanitized.value = sanitizeDisplayText(sanitized.value);
    }
    else if (isQuantityEntry(sanitized)) {
        sanitized.quantity = sanitizeAccountingQuantity(sanitized.quantity);
    }
    else if (isPercentEntry(sanitized) && sanitized.basis) {
        sanitized.basis = sanitizeAccountingBasis(sanitized.basis);
    }
    return sanitized;
}
export function sanitizeQuotaToastError(error) {
    return {
        label: sanitizeDisplayText(error.label),
        message: sanitizeDisplayText(error.message),
        ...(error.retryable === true ? { retryable: true } : {}),
        ...(error.kind ? { kind: error.kind } : {}),
    };
}
export function sanitizeQuotaProviderResult(result) {
    return {
        attempted: result.attempted,
        entries: result.entries.map(sanitizeQuotaToastEntry),
        errors: result.errors.map(sanitizeQuotaToastError),
        ...(result.diagnostics
            ? {
                diagnostics: result.diagnostics.map((diagnostic) => ({
                    ...diagnostic,
                    modelIds: diagnostic.modelIds ? [...diagnostic.modelIds] : null,
                    checkedPaths: [...diagnostic.checkedPaths],
                    authPaths: [...diagnostic.authPaths],
                })),
            }
            : {}),
        ...(result.statusDetails
            ? {
                statusDetails: result.statusDetails.map((detail) => ({
                    key: sanitizeDisplayText(detail.key),
                    value: sanitizeDisplayText(detail.value),
                })),
            }
            : {}),
        ...(result.rawDetails
            ? {
                rawDetails: result.rawDetails.map((detail) => ({
                    key: sanitizeDisplayText(detail.key),
                    value: sanitizeDisplayText(detail.value),
                })),
            }
            : {}),
        ...(result.presentation
            ? {
                presentation: {
                    ...result.presentation,
                    ...(result.presentation.singleWindowDisplayName !== undefined
                        ? {
                            singleWindowDisplayName: sanitizeDisplayText(result.presentation.singleWindowDisplayName),
                        }
                        : {}),
                    ...(result.presentation.redundantQuotaFamily !== undefined
                        ? {
                            redundantQuotaFamily: sanitizeDisplayText(result.presentation.redundantQuotaFamily),
                        }
                        : {}),
                },
            }
            : {}),
    };
}
export function sanitizeSessionTokensData(data) {
    if (!data)
        return undefined;
    return {
        ...data,
        models: data.models.map((model) => ({
            ...model,
            modelID: sanitizeDisplayText(model.modelID),
        })),
    };
}
export function sanitizeQuotaRenderData(data) {
    return {
        entries: data.entries.map(sanitizeQuotaToastEntry),
        errors: data.errors.map(sanitizeQuotaToastError),
        sessionTokens: sanitizeSessionTokensData(data.sessionTokens),
    };
}
