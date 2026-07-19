import { PayloadValidationError } from "./errors.js";
import { isValidBreadcrumbPath, resolveBreadcrumbs } from "./menu.js";
import type {
  MenuElement,
  ReportDraft,
  ReportMenu,
  SubmissionPayload
} from "./types.js";

function isNonEmpty(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

function dataRecord(element: MenuElement): Record<string, unknown> | null {
  return typeof element.data === "object" && element.data !== null
    ? (element.data as Record<string, unknown>)
    : null;
}

function validateElementValue(element: MenuElement, value: unknown): void {
  const data = dataRecord(element);

  if (typeof value === "string") {
    const characterLimit = data?.character_limit;
    if (typeof characterLimit === "number" && value.length > characterLimit) {
      throw new PayloadValidationError(
        `${element.name} exceeds its ${characterLimit}-character limit.`
      );
    }

    const pattern = data?.pattern;
    if (typeof pattern === "string" && !new RegExp(pattern).test(value)) {
      throw new PayloadValidationError(`${element.name} has an invalid format.`);
    }
  }

  if (element.type === "dropdown" && typeof value === "string") {
    const options = data?.options;
    if (Array.isArray(options)) {
      const allowed = options.some(
        (option) =>
          typeof option === "object" &&
          option !== null &&
          (option as Record<string, unknown>).value === value
      );
      if (!allowed) {
        throw new PayloadValidationError(`${element.name} is not an allowed option.`);
      }
    }
  }

  if (element.type === "checkbox" && Array.isArray(value) && Array.isArray(element.data)) {
    const allowed = new Set<string>();
    for (const option of element.data) {
      if (Array.isArray(option) && typeof option[0] === "string") {
        allowed.add(option[0]);
      }
    }
    for (const selection of value) {
      if (typeof selection !== "string" || !allowed.has(selection)) {
        throw new PayloadValidationError(
          `${element.name} contains an unsupported selection.`
        );
      }
    }
  }
}

export function buildElements(draft: ReportDraft): Record<string, unknown> {
  const elements: Record<string, unknown> = {
    reporter_country: draft.reporter.country,
    reporter_legal_name: draft.reporter.legalName,
    confirmation_select: ["validation"]
  };

  if (draft.reporter.username !== undefined) {
    elements.reporter_username = draft.reporter.username;
  }
  if (draft.context !== undefined) {
    elements.dsa_free_text = draft.context;
  }

  switch (draft.flow) {
    case "user_urf":
      elements.reported_username = draft.reportedUsername;
      elements.user_profile_select = draft.profileElements;
      if (draft.reportedUserServerId !== undefined) {
        elements.reported_user_server_id = draft.reportedUserServerId;
      }
      break;
    case "message_urf":
      elements.reported_message_url = draft.messageUrl;
      break;
    case "guild_urf":
      elements.reported_guild_id_or_invite_code = draft.guildIdOrInviteCode;
      elements.guild_select = draft.guildElements;
      break;
  }

  return elements;
}

export function validateElements(
  menu: ReportMenu,
  breadcrumbs: readonly number[],
  elements: Record<string, unknown>
): void {
  if (!isValidBreadcrumbPath(menu, breadcrumbs)) {
    throw new PayloadValidationError("Breadcrumbs are not a valid path through the menu.");
  }

  for (const nodeId of breadcrumbs) {
    const node = menu.nodes[String(nodeId)];
    if (!node) {
      throw new PayloadValidationError(`Breadcrumb references missing node ${nodeId}.`);
    }

    for (const element of node.elements) {
      const value = elements[element.name];
      if (element.should_submit_data && !isNonEmpty(value)) {
        throw new PayloadValidationError(`${element.name} is required by node ${nodeId}.`);
      }
      if (value !== undefined) validateElementValue(element, value);
    }
  }
}

export function buildSubmissionPayload(
  menu: ReportMenu,
  draft: ReportDraft,
  emailToken: string,
  language = "en"
): SubmissionPayload {
  if (menu.name !== draft.flow) {
    throw new PayloadValidationError(
      `Draft flow ${draft.flow} does not match menu ${menu.name}.`
    );
  }
  if (emailToken.trim().length === 0) {
    throw new PayloadValidationError("emailToken must not be empty.");
  }

  const breadcrumbs = resolveBreadcrumbs(menu, draft.reportType);
  const elements = buildElements(draft);
  validateElements(menu, breadcrumbs, elements);

  return {
    version: menu.version,
    variant: menu.variant,
    language,
    breadcrumbs,
    elements,
    email_token: emailToken,
    name: draft.flow
  };
}
