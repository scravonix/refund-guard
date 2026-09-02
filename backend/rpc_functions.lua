local http = require("http")
local json = require("json")
local logger = require("logger")
local millennium = require("millennium")

local function safe_string(value)
    if value == nil then
        return ""
    end

    return tostring(value)
end

local function clamp_number(value, minimum, maximum)
    local numeric = tonumber(value)

    if numeric == nil or numeric ~= numeric or numeric == math.huge or numeric == -math.huge then
        return minimum
    end

    if numeric < minimum then
        return minimum
    end

    if numeric > maximum then
        return maximum
    end

    return numeric
end

local function encode_result(value)
    local ok, encoded = pcall(json.encode, value)

    if ok and type(encoded) == "string" then
        return encoded
    end

    return [[{"ok":false,"error":"Refund Guard could not encode the backend response."}]]
end

local function error_result(id_key, id_value, message)
    local result = {
        ok = false,
        error = safe_string(message)
    }

    result[id_key] = id_value
    return result
end



-- Process-wide automatic-scan arbitration. Millennium can mount Refund Guard
-- into more than one frontend context. These Lua module globals are shared by
-- the backend process, so they can deduplicate schedule logs and ensure that
-- only one frontend context starts an automatic scan for a given due slot.
local last_auto_schedule_key = ""
local last_auto_due_claim_key = ""
local last_auto_due_claimed_at = 0

---@ffi
---@param schedule_key string
---@return string
function registerAutoScheduleJson(schedule_key)
    if type(schedule_key) ~= "string" or schedule_key == "" then
        return encode_result({ ok = false, error = "Automatic schedule key must be a non-empty string." })
    end

    local first = schedule_key ~= last_auto_schedule_key
    if first then
        last_auto_schedule_key = schedule_key
    end

    return encode_result({ ok = true, first = first })
end

---@ffi
---@param schedule_key string
---@param now_seconds number
---@return string
function claimAutoScanDueJson(schedule_key, now_seconds)
    if type(schedule_key) ~= "string" or schedule_key == "" then
        return encode_result({ ok = false, claimed = false, error = "Automatic due key must be a non-empty string." })
    end

    local now_value = math.floor(tonumber(now_seconds) or 0)
    if now_value <= 0 then
        return encode_result({ ok = false, claimed = false, error = "Automatic due timestamp is invalid." })
    end

    -- A due slot may only be claimed once for two minutes. This prevents two
    -- independent frontend contexts from starting the same automatic scan.
    if last_auto_due_claim_key == schedule_key
        and (now_value - last_auto_due_claimed_at) < 120 then
        return encode_result({ ok = true, claimed = false })
    end

    last_auto_due_claim_key = schedule_key
    last_auto_due_claimed_at = now_value
    return encode_result({ ok = true, claimed = true })
end

local PLUGIN_VERSION = "1.0.0"
local BACKEND_API_VERSION = 1
local CURRENT_STATE_SCHEMA_VERSION = 1

---@ffi
---@return string
function getRuntimeInfoJson()
    return encode_result({
        ok = true,
        plugin_version = PLUGIN_VERSION,
        backend_api_version = BACKEND_API_VERSION,
        state_schema_version = CURRENT_STATE_SCHEMA_VERSION,
        millennium_version = safe_string(millennium.version())
    })
end

local function current_state_schema_version()
    local value = tonumber(millennium.config.get("state_schema_version")) or 0
    return math.floor(value)
end

local function schema_write_guard()
    local current = current_state_schema_version()

    if current > CURRENT_STATE_SCHEMA_VERSION then
        return false,
            "Saved data uses newer Refund Guard state schema "
            .. tostring(current)
            .. ". Install a matching/newer Refund Guard version before changing or scanning."
    end

    return true, ""
end

local USER_CONFIG_KEYS = {
    enabled = "boolean",
    notify_price_drops = "boolean",
    auto_scan_enabled = "boolean",
    include_dlc = "boolean",
    strict_eligibility = "boolean",
    refund_window_days = "number",
    playtime_limit_minutes = "number",
    minimum_discount_percent = "number",
    scan_interval_minutes = "number"
}

local USER_CONFIG_RANGES = {
    refund_window_days = { 1, 90 },
    playtime_limit_minutes = { 1, 10000 },
    minimum_discount_percent = { 1, 100 },
    scan_interval_minutes = { 30, 1440 }
}

local ALLOWED_SCAN_INTERVALS = {
    [30] = true,
    [60] = true,
    [120] = true,
    [240] = true,
    [480] = true,
    [720] = true,
    [1440] = true
}

local MAX_PERSISTED_JSON_LENGTH = 2000000

local SNAPSHOT_KEYS = {
    "enabled",
    "notify_price_drops",
    "auto_scan_enabled",
    "include_dlc",
    "strict_eligibility",
    "refund_window_days",
    "playtime_limit_minutes",
    "minimum_discount_percent",
    "scan_interval_minutes",
    "price_baselines_json",
    "paid_price_cache_json",
    "notification_fingerprints_json",
    "last_results_json",
    "last_scan_time",
    "state_schema_version"
}

local function config_error(message)
    return encode_result({
        ok = false,
        error = safe_string(message)
    })
end

---Return the complete Refund Guard persisted snapshot.
---No frontend Millennium config API is used; this avoids the 3.4.1
---JSON type mismatch seen when numeric config values are present.
---@ffi
---@return string
function getConfigSnapshotJson()
    local snapshot = {}

    for _, key in ipairs(SNAPSHOT_KEYS) do
        snapshot[key] = millennium.config.get(key)
    end

    return encode_result(snapshot)
end

---Persist all user-facing configuration in one call.
---The FFI boundary receives one JSON STRING only.
---@ffi
---@param config_json string
---@return string
function setUserConfigJson(config_json)
    local schema_ok, schema_error = schema_write_guard()
    if not schema_ok then
        return config_error(schema_error)
    end

    if type(config_json) ~= "string" or config_json == "" then
        return config_error("Config payload must be a JSON string.")
    end

    local decode_ok, decoded = pcall(json.decode, config_json)

    if not decode_ok or type(decoded) ~= "table" then
        return config_error("Config payload could not be decoded.")
    end

    -- Validate every supported setting before writing anything, so a malformed
    -- payload cannot leave the config half-updated.
    for key, expected_type in pairs(USER_CONFIG_KEYS) do
        local value = decoded[key]

        if type(value) ~= expected_type then
            return config_error(
                "Invalid type for setting "
                .. key
                .. ": expected "
                .. expected_type
                .. ", got "
                .. type(value)
            )
        end

        if expected_type == "number" then
            if value ~= value or value == math.huge or value == -math.huge then
                return config_error("Invalid numeric value for setting " .. key .. ".")
            end

            local range = USER_CONFIG_RANGES[key]
            if range ~= nil and (value < range[1] or value > range[2]) then
                return config_error(
                    "Setting " .. key .. " is outside the supported range."
                )
            end

            if key == "scan_interval_minutes" and not ALLOWED_SCAN_INTERVALS[value] then
                return config_error("Unsupported automatic scan interval.")
            end
        end
    end

    for key, _ in pairs(USER_CONFIG_KEYS) do
        millennium.config.set(key, decoded[key])
    end

    return encode_result({ ok = true })
end

---Persist scanner-only state in one call.
---Again, only one string crosses the FFI boundary.
---@ffi
---@param state_json string
---@return string
function saveScanStateJson(state_json)
    local schema_ok, schema_error = schema_write_guard()
    if not schema_ok then
        return config_error(schema_error)
    end

    if type(state_json) ~= "string" or state_json == "" then
        return config_error("Scanner state payload must be a JSON string.")
    end

    local decode_ok, decoded = pcall(json.decode, state_json)

    if not decode_ok or type(decoded) ~= "table" then
        return config_error("Scanner state payload could not be decoded.")
    end

    if type(decoded.price_baselines_json) ~= "string" then
        return config_error("price_baselines_json must be a string.")
    end

    if type(decoded.paid_price_cache_json) ~= "string" then
        return config_error("paid_price_cache_json must be a string.")
    end

    if type(decoded.notification_fingerprints_json) ~= "string" then
        return config_error("notification_fingerprints_json must be a string.")
    end

    if type(decoded.last_results_json) ~= "string" then
        return config_error("last_results_json must be a string.")
    end

    for _, key in ipairs({
        "price_baselines_json",
        "paid_price_cache_json",
        "notification_fingerprints_json",
        "last_results_json"
    }) do
        if #decoded[key] > MAX_PERSISTED_JSON_LENGTH then
            return config_error(key .. " exceeds the safe persisted-state size limit.")
        end
    end

    if type(decoded.last_scan_time) ~= "number" then
        return config_error("last_scan_time must be a number.")
    end

    if decoded.last_scan_time ~= decoded.last_scan_time
        or decoded.last_scan_time < 0
        or decoded.last_scan_time > 4102444800 then
        return config_error("last_scan_time is outside the supported range.")
    end

    millennium.config.set(
        "price_baselines_json",
        decoded.price_baselines_json
    )
    millennium.config.set(
        "paid_price_cache_json",
        decoded.paid_price_cache_json
    )
    millennium.config.set(
        "notification_fingerprints_json",
        decoded.notification_fingerprints_json
    )
    millennium.config.set(
        "last_results_json",
        decoded.last_results_json
    )
    millennium.config.set(
        "last_scan_time",
        decoded.last_scan_time
    )

    return encode_result({ ok = true })
end

local function format_price(minor_units, currency)
    local value = tonumber(minor_units)

    if value == nil then
        return ""
    end

    local amount = value / 100
    local code = safe_string(currency)

    if code == "USD" then
        return string.format("$%.2f USD", amount)
    elseif code == "EUR" then
        return string.format("%.2f EUR", amount)
    elseif code == "GBP" then
        return string.format("%.2f GBP", amount)
    end

    if code ~= "" then
        return string.format("%.2f %s", amount, code)
    end

    return string.format("%.2f", amount)
end

local function request_json(url, label)
    local response, request_error = http.get(url, {
        headers = {
            ["Accept"] = "application/json"
        },
        timeout = 8,
        user_agent = "RefundGuard/1.0.0"
    })

    if response == nil then
        logger:warn(
            label
            .. " request returned nil: "
            .. safe_string(request_error)
        )

        return nil, request_error or (label .. " request failed")
    end

    if tonumber(response.status) ~= 200 then
        logger:warn(
            label
            .. " returned HTTP "
            .. safe_string(response.status)
        )

        return nil, label .. " returned HTTP " .. safe_string(response.status)
    end

    if type(response.body) ~= "string" or response.body == "" then
        return nil, label .. " returned an empty response"
    end

    local decode_ok, decoded = pcall(json.decode, response.body)

    if not decode_ok or type(decoded) ~= "table" then
        logger:warn(label .. " response could not be decoded")
        return nil, label .. " response could not be decoded"
    end

    return decoded, nil
end

---Fetch the authenticated Steam Store purchase-history HTML using cookies
---read from Steam webhelper's in-memory cookie jar by the frontend. Cookie
---values are never logged or persisted by Refund Guard.
---@ffi
---@param cookie_header string
---@return string
function getPurchaseHistoryHtml(cookie_header)
    if type(cookie_header) ~= "string" or cookie_header == "" then
        return encode_result({
            ok = false,
            status = 0,
            error = "Steam Store cookie header is empty."
        })
    end

    if #cookie_header > 24576 then
        return encode_result({
            ok = false,
            status = 0,
            error = "Steam Store cookie header is unexpectedly large."
        })
    end

    -- Prevent header injection across the FFI boundary.
    if string.find(cookie_header, "\r", 1, true)
        or string.find(cookie_header, "\n", 1, true)
    then
        return encode_result({
            ok = false,
            status = 0,
            error = "Steam Store cookie header contains invalid characters."
        })
    end

    local response, request_error = http.get(
        "https://store.steampowered.com/account/history/?l=english",
        {
            headers = {
                ["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                ["Accept-Language"] = "en-US,en;q=0.9",
                ["Cookie"] = cookie_header,
                ["Referer"] = "https://store.steampowered.com/account/"
            },
            timeout = 15,
            follow_redirects = true,
            user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36"
        }
    )

    if response == nil then
        return encode_result({
            ok = false,
            status = 0,
            error = safe_string(request_error or "Steam purchase history request failed")
        })
    end

    local body = type(response.body) == "string" and response.body or ""

    if tonumber(response.status) ~= 200 then
        return encode_result({
            ok = false,
            status = tonumber(response.status) or 0,
            error = "Steam purchase history returned HTTP " .. safe_string(response.status)
        })
    end

    if body == "" then
        return encode_result({
            ok = false,
            status = tonumber(response.status) or 0,
            error = "Steam purchase history returned an empty response."
        })
    end

    return encode_result({
        ok = true,
        status = tonumber(response.status) or 200,
        body = body
    })
end


local function form_url_encode(value)
    local text = tostring(value or "")

    return string.gsub(text, "([^%w%-_%.~])", function(char)
        return string.format("%%%02X", string.byte(char))
    end)
end

local function validate_cookie_header(cookie_header)
    if type(cookie_header) ~= "string" or cookie_header == "" then
        return false, "Steam Store cookie header is empty."
    end

    if #cookie_header > 24576 then
        return false, "Steam Store cookie header is unexpectedly large."
    end

    if string.find(cookie_header, "\r", 1, true)
        or string.find(cookie_header, "\n", 1, true)
    then
        return false, "Steam Store cookie header contains invalid characters."
    end

    return true, nil
end

---Fetch one additional Steam Store purchase-history page.
---Steam's page JavaScript posts g_historyCursor + g_sessionID to
---/account/AjaxLoadMoreHistory/. Cursor can be a scalar or a JSON object.
---@ffi
---@param cookie_header string
---@param cursor_json string
---@param session_id string
---@return string
function getPurchaseHistoryPage(cookie_header, cursor_json, session_id)
    local valid_cookie, cookie_error = validate_cookie_header(cookie_header)

    if not valid_cookie then
        return encode_result({
            ok = false,
            status = 0,
            error = cookie_error
        })
    end

    if type(session_id) ~= "string"
        or session_id == ""
        or #session_id > 256
        or string.find(session_id, "\r", 1, true)
        or string.find(session_id, "\n", 1, true)
    then
        return encode_result({
            ok = false,
            status = 0,
            error = "Steam purchase-history session ID is invalid."
        })
    end

    if type(cursor_json) ~= "string" or cursor_json == "" or #cursor_json > 8192 then
        return encode_result({
            ok = false,
            status = 0,
            error = "Steam purchase-history cursor is invalid."
        })
    end

    local decode_ok, cursor = pcall(json.decode, cursor_json)

    if not decode_ok then
        cursor = cursor_json
    end

    local fields = {
        "sessionid=" .. form_url_encode(session_id)
    }

    if type(cursor) == "table" then
        local keys = {}

        for key, value in pairs(cursor) do
            local value_type = type(value)

            if value_type == "string" or value_type == "number" or value_type == "boolean" then
                table.insert(keys, tostring(key))
            end
        end

        table.sort(keys)

        for _, key in ipairs(keys) do
            local value = cursor[key]

            if value == nil then
                value = cursor[tonumber(key)]
            end

            table.insert(
                fields,
                "cursor%5B"
                    .. form_url_encode(key)
                    .. "%5D="
                    .. form_url_encode(value)
            )
        end
    else
        table.insert(fields, "cursor=" .. form_url_encode(cursor))
    end

    local response, request_error = http.post(
        "https://store.steampowered.com/account/AjaxLoadMoreHistory/",
        table.concat(fields, "&"),
        {
            headers = {
                ["Accept"] = "application/json, text/javascript, */*; q=0.01",
                ["Accept-Language"] = "en-US,en;q=0.9",
                ["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8",
                ["Cookie"] = cookie_header,
                ["Origin"] = "https://store.steampowered.com",
                ["Referer"] = "https://store.steampowered.com/account/history/?l=english",
                ["X-Requested-With"] = "XMLHttpRequest"
            },
            timeout = 15,
            follow_redirects = true,
            user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36"
        }
    )

    if response == nil then
        return encode_result({
            ok = false,
            status = 0,
            error = safe_string(request_error or "Steam purchase-history pagination request failed")
        })
    end

    if tonumber(response.status) ~= 200 then
        return encode_result({
            ok = false,
            status = tonumber(response.status) or 0,
            error = "Steam purchase-history pagination returned HTTP " .. safe_string(response.status)
        })
    end

    local body = type(response.body) == "string" and response.body or ""
    local json_ok, decoded = pcall(json.decode, body)

    if not json_ok or type(decoded) ~= "table" then
        return encode_result({
            ok = false,
            status = tonumber(response.status) or 200,
            error = "Steam purchase-history pagination returned invalid JSON."
        })
    end

    local cursor_out = ""

    if decoded.cursor ~= nil then
        local cursor_ok, encoded_cursor = pcall(json.encode, decoded.cursor)

        if cursor_ok and type(encoded_cursor) == "string" then
            cursor_out = encoded_cursor
        end
    end

    return encode_result({
        ok = true,
        status = tonumber(response.status) or 200,
        html = safe_string(decoded.html),
        cursor_json = cursor_out
    })
end

---Fetch the authenticated receipt for one Steam transaction. The receipt page
---contains per-line item amounts even when the history row is a multi-item cart.
---@ffi
---@param cookie_header string
---@param transaction_id string
---@return string
function getPurchaseReceiptHtml(cookie_header, transaction_id)
    local valid_cookie, cookie_error = validate_cookie_header(cookie_header)

    if not valid_cookie then
        return encode_result({
            ok = false,
            status = 0,
            error = cookie_error
        })
    end

    if type(transaction_id) ~= "string"
        or not string.match(transaction_id, "^%d+$")
        or #transaction_id > 32
    then
        return encode_result({
            ok = false,
            status = 0,
            error = "Steam transaction ID is invalid."
        })
    end

    local response, request_error = http.get(
        "https://store.steampowered.com/account/receipt/"
            .. transaction_id
            .. "?l=english",
        {
            headers = {
                ["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                ["Accept-Language"] = "en-US,en;q=0.9",
                ["Cookie"] = cookie_header,
                ["Referer"] = "https://store.steampowered.com/account/history/?l=english"
            },
            timeout = 15,
            follow_redirects = true,
            user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36"
        }
    )

    if response == nil then
        return encode_result({
            ok = false,
            status = 0,
            error = safe_string(request_error or "Steam purchase receipt request failed")
        })
    end

    local body = type(response.body) == "string" and response.body or ""

    if tonumber(response.status) ~= 200 then
        return encode_result({
            ok = false,
            status = tonumber(response.status) or 0,
            error = "Steam purchase receipt returned HTTP " .. safe_string(response.status)
        })
    end

    if body == "" then
        return encode_result({
            ok = false,
            status = tonumber(response.status) or 0,
            error = "Steam purchase receipt returned an empty response."
        })
    end

    return encode_result({
        ok = true,
        status = tonumber(response.status) or 200,
        body = body
    })
end

local function collect_package_options(data)
    local result = {}
    local seen = {}

    local function add_package(package_id, option_text, price, percent_savings)
        local numeric_id = math.floor(tonumber(package_id) or 0)

        if numeric_id <= 0 or seen[numeric_id] then
            return
        end

        seen[numeric_id] = true

        table.insert(result, {
            package_id = numeric_id,
            option_text = safe_string(option_text),
            price = math.floor(clamp_number(price, 0, 100000000000)),
            percent_savings = clamp_number(percent_savings, 0, 100)
        })
    end

    if type(data.package_groups) == "table" then
        for _, group in pairs(data.package_groups) do
            if type(group) == "table" and type(group.subs) == "table" then
                for _, sub in pairs(group.subs) do
                    if type(sub) == "table" then
                        add_package(
                            sub.packageid,
                            sub.option_text,
                            sub.price_in_cents_with_discount,
                            sub.percent_savings
                        )
                    end
                end
            end
        end
    end

    -- Some Store responses expose package IDs in data.packages even if the
    -- purchase-option group does not contain a rich entry for every package.
    if type(data.packages) == "table" then
        for _, package_id in pairs(data.packages) do
            add_package(package_id, "", 0, 0)
        end
    end

    return result
end

local function normalize_country_code(value)
    if type(value) ~= "string" then
        return ""
    end

    local normalized = string.upper(
        string.match(value, "^%s*(.-)%s*$") or ""
    )

    if string.match(normalized, "^[A-Z][A-Z]$") then
        return normalized
    end

    return ""
end

local function build_country_attempts(country_code)
    local attempts = {}
    local seen = {}

    local function add(value)
        local normalized = normalize_country_code(value)
        local key = normalized == "" and "<automatic>" or normalized

        if seen[key] then
            return
        end

        seen[key] = true
        table.insert(attempts, normalized)
    end

    add(country_code)
    add("")
    add("US")

    return attempts
end

---Fetch public Steam Store details for one AppID.
---Country code is supplied by SteamClient.User.GetIPCountry when available so
---Store app and package prices resolve in the same regional catalog.
---@ffi
---@param app_id number
---@param country_code string
---@return string
function getStoreDetailsJson(app_id, country_code)
    local numeric_app_id = math.floor(tonumber(app_id) or 0)

    if numeric_app_id <= 0 then
        return encode_result(
            error_result("app_id", numeric_app_id, "Invalid AppID")
        )
    end

    local data = nil
    local resolved_country = ""
    local last_error = "Steam Store request failed"

    for _, attempt_country in ipairs(build_country_attempts(country_code)) do
        local url =
            "https://store.steampowered.com/api/appdetails?appids="
            .. tostring(numeric_app_id)
            .. "&l=english"

        if attempt_country ~= "" then
            url = url .. "&cc=" .. attempt_country
        end

        local decoded, request_error = request_json(
            url,
            "Steam Store AppID "
            .. tostring(numeric_app_id)
            .. " ["
            .. (attempt_country ~= "" and attempt_country or "automatic")
            .. "]"
        )

        if decoded ~= nil then
            local app_entry = decoded[tostring(numeric_app_id)]

            if type(app_entry) == "table"
                and app_entry.success == true
                and type(app_entry.data) == "table"
            then
                data = app_entry.data
                resolved_country = attempt_country
                break
            end

            last_error = "Steam Store did not return app details"
        elseif request_error ~= nil then
            -- A transport/HTTP failure is not fixed by retrying the same
            -- endpoint with a different regional cc parameter. Stop here so
            -- offline/rate-limited scans fail fast instead of multiplying
            -- timeout delays across country fallbacks.
            last_error = request_error
            break
        end
    end

    if type(data) ~= "table" then
        return encode_result(
            error_result(
                "app_id",
                numeric_app_id,
                last_error
            )
        )
    end

    local price = data.price_overview
    local package_options = collect_package_options(data)

    if type(price) ~= "table" then
        return encode_result({
            ok = true,
            app_id = numeric_app_id,
            name = safe_string(data.name),
            header_image = safe_string(data.header_image),
            store_type = safe_string(data.type),
            fullgame_app_id = type(data.fullgame) == "table" and (tonumber(data.fullgame.appid) or 0) or 0,
            fullgame_name = type(data.fullgame) == "table" and safe_string(data.fullgame.name) or "",
            is_free = data.is_free == true,
            has_price = false,
            currency = "",
            initial = 0,
            final = 0,
            discount_percent = 0,
            formatted_initial = "",
            formatted_final = "",
            country_code = resolved_country,
            package_options = package_options
        })
    end

    return encode_result({
        ok = true,
        app_id = numeric_app_id,
        name = safe_string(data.name),
        header_image = safe_string(data.header_image),
        store_type = safe_string(data.type),
        fullgame_app_id = type(data.fullgame) == "table" and (tonumber(data.fullgame.appid) or 0) or 0,
        fullgame_name = type(data.fullgame) == "table" and safe_string(data.fullgame.name) or "",
        is_free = data.is_free == true,
        has_price = true,
        currency = safe_string(price.currency),
        initial = math.floor(clamp_number(price.initial, 0, 100000000000)),
        final = math.floor(clamp_number(price.final, 0, 100000000000)),
        discount_percent = clamp_number(price.discount_percent, 0, 100),
        formatted_initial = safe_string(price.initial_formatted),
        formatted_final = safe_string(price.final_formatted),
        country_code = resolved_country,
        package_options = package_options
    })
end

---Fetch public details for one Steam package/sub.
---The Store packagedetails endpoint can behave differently by regional catalog,
---so this function tries the user's Steam country first, then automatic routing,
---then US as a metadata fallback. Package CONTENT matching never depends on
---price alone.
---@ffi
---@param package_id number
---@param country_code string
---@return string
function getPackageDetailsJson(package_id, country_code)
    local numeric_package_id = math.floor(tonumber(package_id) or 0)

    if numeric_package_id <= 0 then
        return encode_result(
            error_result(
                "package_id",
                numeric_package_id,
                "Invalid package ID"
            )
        )
    end

    local last_error = "Steam package request failed"
    local best_data = nil
    local best_country = ""

    for _, attempt_country in ipairs(build_country_attempts(country_code)) do
        local url =
            "https://store.steampowered.com/api/packagedetails/?packageids="
            .. tostring(numeric_package_id)
            .. "&l=english"

        if attempt_country ~= "" then
            url = url .. "&cc=" .. attempt_country
        end

        local decoded, request_error = request_json(
            url,
            "Steam Store package "
            .. tostring(numeric_package_id)
            .. " ["
            .. (attempt_country ~= "" and attempt_country or "automatic")
            .. "]"
        )

        if decoded ~= nil then
            local package_entry = decoded[tostring(numeric_package_id)]

            if type(package_entry) == "table"
                and package_entry.success == true
                and type(package_entry.data) == "table"
            then
                local data = package_entry.data
                local app_count = 0

                if type(data.apps) == "table" then
                    for _, app in pairs(data.apps) do
                        if type(app) == "table"
                            and math.floor(tonumber(app.id) or 0) > 0
                        then
                            app_count = app_count + 1
                        end
                    end
                end

                -- Prefer a response that actually exposes package contents.
                if app_count > 0 then
                    best_data = data
                    best_country = attempt_country
                    break
                end

                if best_data == nil then
                    best_data = data
                    best_country = attempt_country
                end

                last_error =
                    "Steam package response did not expose package contents"
            else
                last_error =
                    "Steam Store did not return package details"
            end
        elseif request_error ~= nil then
            -- Transport/HTTP failures are not regional-catalog misses. Avoid
            -- repeating the same failing request for automatic/US fallbacks.
            last_error = request_error
            break
        end
    end

    if type(best_data) ~= "table" then
        return encode_result(
            error_result(
                "package_id",
                numeric_package_id,
                last_error
            )
        )
    end

    local apps = {}

    if type(best_data.apps) == "table" then
        for _, app in pairs(best_data.apps) do
            if type(app) == "table" then
                local app_id = math.floor(tonumber(app.id) or 0)

                if app_id > 0 then
                    table.insert(apps, {
                        id = app_id,
                        name = safe_string(app.name)
                    })
                end
            end
        end
    end

    if #apps == 0 then
        return encode_result({
            ok = false,
            package_id = numeric_package_id,
            name = safe_string(best_data.name),
            apps = apps,
            has_price = false,
            country_code = best_country,
            error = last_error
        })
    end

    local price = best_data.price

    if type(price) ~= "table" then
        return encode_result({
            ok = true,
            package_id = numeric_package_id,
            name = safe_string(best_data.name),
            apps = apps,
            has_price = false,
            currency = "",
            initial = 0,
            final = 0,
            discount_percent = 0,
            formatted_initial = "",
            formatted_final = "",
            country_code = best_country
        })
    end

    local currency = safe_string(price.currency)
    local initial = math.floor(clamp_number(price.initial, 0, 100000000000))
    local final = math.floor(clamp_number(price.final, 0, 100000000000))

    return encode_result({
        ok = true,
        package_id = numeric_package_id,
        name = safe_string(best_data.name),
        apps = apps,
        has_price = true,
        currency = currency,
        initial = initial,
        final = final,
        discount_percent = clamp_number(price.discount_percent, 0, 100),
        formatted_initial = format_price(initial, currency),
        formatted_final = format_price(final, currency),
        country_code = best_country
    })
end