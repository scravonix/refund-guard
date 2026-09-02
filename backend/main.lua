local logger = require("logger")
local millennium = require("millennium")

-- Registers the global @ffi functions used by the frontend.
require("rpc_functions")

local PLUGIN_VERSION = "1.0.0"
local BACKEND_API_VERSION = 1
local CURRENT_STATE_SCHEMA_VERSION = 1

local ALLOWED_SCAN_INTERVALS = {
    [30] = true,
    [60] = true,
    [120] = true,
    [240] = true,
    [480] = true,
    [720] = true,
    [1440] = true
}

local NUMERIC_CONFIG_RANGES = {
    refund_window_days = { 1, 90 },
    playtime_limit_minutes = { 1, 10000 },
    minimum_discount_percent = { 1, 100 },
    scan_interval_minutes = { 30, 1440 }
}

local DEFAULTS = {
    enabled = true,
    notify_price_drops = true,
    auto_scan_enabled = false,
    include_dlc = false,
    strict_eligibility = true,
    refund_window_days = 14,
    playtime_limit_minutes = 120,
    minimum_discount_percent = 10,
    scan_interval_minutes = 60,

    -- Internal/persistent state. These are intentionally not shown as normal
    -- user-facing settings.
    price_baselines_json = "{}",
    paid_price_cache_json = "{}",
    notification_fingerprints_json = "{}",
    last_results_json = "[]",
    last_scan_time = 0,
    state_schema_version = CURRENT_STATE_SCHEMA_VERSION
}

local function ensure_defaults()
    for key, default_value in pairs(DEFAULTS) do
        local current_value = millennium.config.get(key)

        if current_value == nil or type(current_value) ~= type(default_value) then
            if current_value ~= nil then
                logger:warn(
                    "Resetting invalid config type for "
                    .. tostring(key)
                    .. ": expected "
                    .. type(default_value)
                    .. ", got "
                    .. type(current_value)
                )
            end

            millennium.config.set(key, default_value)
        end
    end
end

local function sanitize_startup_config()
    for key, range in pairs(NUMERIC_CONFIG_RANGES) do
        local value = millennium.config.get(key)
        local default_value = DEFAULTS[key]

        if type(value) ~= "number"
            or value ~= value
            or value == math.huge
            or value == -math.huge
            or value < range[1]
            or value > range[2]
            or (key == "scan_interval_minutes" and not ALLOWED_SCAN_INTERVALS[value]) then
            logger:warn("Resetting unsupported config value for " .. tostring(key))
            millennium.config.set(key, default_value)
        end
    end
end

local function migrate_state_schema(previous_schema)
    local numeric_previous = tonumber(previous_schema) or 0

    if numeric_previous > CURRENT_STATE_SCHEMA_VERSION then
        logger:warn(
            "Persisted state schema "
            .. tostring(numeric_previous)
            .. " is newer than supported schema "
            .. tostring(CURRENT_STATE_SCHEMA_VERSION)
        )
        return
    end

    if numeric_previous < CURRENT_STATE_SCHEMA_VERSION then
        -- Legacy startup-scan config is intentionally retired. Keep it disabled
        -- if an older installation still has the key.
        if millennium.config.get("scan_on_startup") ~= nil then
            millennium.config.set("scan_on_startup", false)
        end

        millennium.config.set("state_schema_version", CURRENT_STATE_SCHEMA_VERSION)
        logger:info(
            "Persisted state schema migrated "
            .. tostring(numeric_previous)
            .. " -> "
            .. tostring(CURRENT_STATE_SCHEMA_VERSION)
        )
    end
end

local function on_load()
    local previous_schema = millennium.config.get("state_schema_version")
    ensure_defaults()
    sanitize_startup_config()
    migrate_state_schema(previous_schema)

    millennium.config.on_change(function(key, value)
        if key ~= "price_baselines_json" and key ~= "paid_price_cache_json" and key ~= "notification_fingerprints_json" and key ~= "last_results_json" then
            logger:info("Config changed: " .. tostring(key) .. " = " .. tostring(value))
        end
    end)

    logger:info(
        "Refund Guard "
        .. PLUGIN_VERSION
        .. " backend ready (API "
        .. tostring(BACKEND_API_VERSION)
        .. ", schema "
        .. tostring(CURRENT_STATE_SCHEMA_VERSION)
        .. ", Millennium "
        .. millennium.version()
        .. ")"
    )
    millennium.ready()
end

local function on_unload()
    logger:info("Refund Guard backend unloaded")
end

local function on_frontend_loaded()
    logger:info("Refund Guard frontend loaded")
end

return {
    on_load = on_load,
    on_unload = on_unload,
    on_frontend_loaded = on_frontend_loaded
}