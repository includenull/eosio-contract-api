import DataProcessor from '../filler/processor.js';

export type ShipTraceFilter = {
    contract: string;
    action: string;
};

export type ShipTableFilter = {
    code: string;
    table: string;
};

export type ShipSidecarFilterRules = {
    traceFilters: ShipTraceFilter[];
    tableFilters: ShipTableFilter[];
    deltaTypes: string[];
};

export function buildShipSidecarFilterRules(processor: DataProcessor): ShipSidecarFilterRules {
    const rules = processor.getRules(true);
    const traceFilters: ShipTraceFilter[] = [
        { contract: 'eosio', action: 'setabi' },
        { contract: 'eosio', action: 'setcode' },
    ];
    const seenTraces = new Set(traceFilters.map(row => `${row.contract}:${row.action}`));

    for (const [contract, rule] of Object.entries(rules)) {
        if (rule.actions.includes('*')) {
            const key = `${contract}:*`;
            if (!seenTraces.has(key)) {
                traceFilters.push({ contract, action: '*' });
                seenTraces.add(key);
            }
            continue;
        }

        for (const action of rule.actions) {
            const key = `${contract}:${action}`;
            if (!seenTraces.has(key)) {
                traceFilters.push({ contract, action });
                seenTraces.add(key);
            }
        }
    }

    const tableFilters: ShipTableFilter[] = [];
    const seenTables = new Set<string>();

    for (const [code, rule] of Object.entries(rules)) {
        if (rule.tables.includes('*')) {
            const key = `${code}:*`;
            if (!seenTables.has(key)) {
                tableFilters.push({ code, table: '*' });
                seenTables.add(key);
            }
            continue;
        }

        for (const table of rule.tables) {
            const key = `${code}:${table}`;
            if (!seenTables.has(key)) {
                tableFilters.push({ code, table });
                seenTables.add(key);
            }
        }
    }

    return {
        traceFilters,
        tableFilters,
        deltaTypes: ['contract_row'],
    };
}
