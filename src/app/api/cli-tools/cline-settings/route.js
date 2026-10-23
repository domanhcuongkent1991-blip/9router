"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

const getDataDir = () => path.join(os.homedir(), ".cline", "data");
const getGlobalStatePath = () => path.join(getDataDir(), "globalState.json");
const getSecretsPath = () => path.join(getDataDir(), "secrets.json");
const getProvidersPath = () => path.join(getDataDir(), "settings", "providers.json");

const checkInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where cline" : "which cline";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getGlobalStatePath());
      return true;
    } catch {
      return false;
    }
  }
};

const readJson = async (filePath) => {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    // Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
    // rather than throwing a 500 that the UI misreads as "tool not installed".
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    return null;
  }
};

// Cline 4.x migrated provider config out of globalState.json into
// settings/providers.json (keyed by mode); globalState.json alone is ignored
// once __openAiBaseUrlV1Migrated is set, so both must be written.
const is9RouterBaseUrl = (baseUrl) => {
  const url = String(baseUrl || "");
  return url.includes("localhost") || url.includes("127.0.0.1") || url.includes("9router");
};

const readProvidersConfig = async () => (await readJson(getProvidersPath())) || null;

const has9RouterProviderConfig = async () => {
  const providers = await readProvidersConfig();
  if (!providers || !providers.providers) return false;
  return Object.values(providers.providers).some((entry) => is9RouterBaseUrl(entry?.settings?.baseUrl));
};

const has9RouterConfig = (globalState) => {
  if (!globalState) return false;
  const isOpenAi =
    globalState.actModeApiProvider === "openai" || globalState.planModeApiProvider === "openai";
  const baseUrl = globalState.openAiBaseUrl || "";
  return isOpenAi && is9RouterBaseUrl(baseUrl);
};

export async function GET() {
  try {
    const installed = await checkInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, settings: null, message: "Cline CLI is not installed" });
    }
    const globalState = await readJson(getGlobalStatePath());
    const providersConfig = await readProvidersConfig();
    const providerEntry = providersConfig?.providers?.["9router"]?.settings;
    return NextResponse.json({
      installed: true,
      settings: {
        actModeApiProvider: globalState?.actModeApiProvider,
        planModeApiProvider: globalState?.planModeApiProvider,
        openAiBaseUrl: globalState?.openAiBaseUrl,
        openAiModelId: globalState?.openAiModelId,
        providersBaseUrl: providerEntry?.baseUrl,
        providersModel: providerEntry?.model,
        providersLastUsed: providersConfig?.lastUsedProvider,
      },
      has9Router: has9RouterConfig(globalState) || (await has9RouterProviderConfig()),
      globalStatePath: getGlobalStatePath(),
      providersPath: getProvidersPath(),
    });
  } catch (error) {
    console.log("Error checking cline settings:", error);
    return NextResponse.json({ error: "Failed to check cline settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model } = await request.json();
    if (!baseUrl || !apiKey || !model) {
      return NextResponse.json({ error: "baseUrl, apiKey and model are required" }, { status: 400 });
    }

    await fs.mkdir(getDataDir(), { recursive: true });

    // Cline expects base WITHOUT /v1
    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;

    const globalState = (await readJson(getGlobalStatePath())) || {};
    globalState.actModeApiProvider = "openai";
    globalState.planModeApiProvider = "openai";
    globalState.openAiBaseUrl = normalizedBaseUrl;
    globalState.openAiModelId = model;
    globalState.planModeOpenAiModelId = model;
    await fs.writeFile(getGlobalStatePath(), JSON.stringify(globalState, null, 2));

    const secrets = (await readJson(getSecretsPath())) || {};
    secrets.openAiApiKey = apiKey;
    await fs.writeFile(getSecretsPath(), JSON.stringify(secrets, null, 2));

    await fs.mkdir(path.dirname(getProvidersPath()), { recursive: true });
    const providersConfig = (await readJson(getProvidersPath())) || { version: 1, providers: {} };
    providersConfig.providers = providersConfig.providers || {};
    providersConfig.providers["9router"] = {
      settings: {
        provider: "openai-compatible",
        protocol: "openai-chat",
        baseUrl: normalizedBaseUrl,
        apiKey,
        model,
      },
      updatedAt: new Date().toISOString(),
    };
    providersConfig.lastUsedProvider = "9router";
    await fs.writeFile(getProvidersPath(), JSON.stringify(providersConfig, null, 2));

    return NextResponse.json({
      success: true,
      message: "Cline settings applied successfully!",
      globalStatePath: getGlobalStatePath(),
      providersPath: getProvidersPath(),
    });
  } catch (error) {
    console.log("Error updating cline settings:", error);
    return NextResponse.json({ error: "Failed to update cline settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const globalState = await readJson(getGlobalStatePath());
    if (!globalState) {
      return NextResponse.json({ success: true, message: "No settings file to reset" });
    }

    if (globalState.actModeApiProvider === "openai") {
      delete globalState.openAiBaseUrl;
      delete globalState.openAiModelId;
      delete globalState.planModeOpenAiModelId;
      globalState.actModeApiProvider = "cline";
      globalState.planModeApiProvider = "cline";
    }
    await fs.writeFile(getGlobalStatePath(), JSON.stringify(globalState, null, 2));

    const secrets = (await readJson(getSecretsPath())) || {};
    delete secrets.openAiApiKey;
    await fs.writeFile(getSecretsPath(), JSON.stringify(secrets, null, 2));

    const providersConfig = await readProvidersConfig();
    if (providersConfig?.providers?.["9router"]) {
      delete providersConfig.providers["9router"];
      if (providersConfig.lastUsedProvider === "9router") {
        delete providersConfig.lastUsedProvider;
      }
      await fs.writeFile(getProvidersPath(), JSON.stringify(providersConfig, null, 2));
    }

    return NextResponse.json({ success: true, message: "9Router settings removed from Cline" });
  } catch (error) {
    console.log("Error resetting cline settings:", error);
    return NextResponse.json({ error: "Failed to reset cline settings" }, { status: 500 });
  }
}
