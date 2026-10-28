/**
 * AP load-balance config as returned by `GET /sites/{siteId}/aps/{apMac}/load-balance` and sent back with PATCH.
 *
 * The spec (`UpdateApAdvancedLoadBalanceOpenApiVO`) only lists `enable` and `maxClients*`. Controllers 6.x also
 * return per-band `maxClientsEnable*`, `rssiEnable*` and `threshold*` (RSSI Threshold, dBm) — those come from the
 * real GET response, not from the spec. Unknown keys are kept so a full-body PATCH does not drop them.
 */
export interface ApLoadBalanceConfig {
    /** Spec field, described as "enable load balance". Not present in the 6.x GET response. */
    enable?: boolean;
    maxClientsEnable2g?: boolean;
    maxClients2g?: number;
    rssiEnable2g?: boolean;
    threshold2g?: number;
    maxClientsEnable5g?: boolean;
    maxClients5g?: number;
    rssiEnable5g?: boolean;
    threshold5g?: number;
    /** Spec PATCH field for 5 GHz-1 of tri-band APs; the 6.x GET has no 5g1 keys. */
    maxClients5g1?: number;
    maxClientsEnable5g2?: boolean;
    maxClients5g2?: number;
    maxClientsEnable6g?: boolean;
    maxClients6g?: number;
    [key: string]: unknown;
}
