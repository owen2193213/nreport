import type {
  MenuElement,
  MenuNode,
  ReportFlow,
  ReportMenu
} from "../src/types.js";

function node(id: number, overrides: Partial<MenuNode> = {}): MenuNode {
  return {
    id,
    key: `NODE_${id}`,
    header: null,
    subheader: null,
    info: null,
    button: null,
    elements: [],
    report_type: null,
    children: [],
    is_multi_select_required: false,
    is_auto_submit: false,
    ...overrides
  };
}

function element(
  name: string,
  type: string,
  data: unknown,
  shouldSubmit = true
): MenuElement {
  return {
    name,
    type,
    data,
    should_submit_data: shouldSubmit,
    skip_if_unlocalized: false,
    is_localized: true
  };
}

const countryData = {
  title: "Country",
  options: [{ value: "DE", label: "Germany" }]
};

export function createMessageMenu(): ReportMenu {
  const nodes: Record<string, MenuNode> = {
    "64": node(64, {
      key: "URF_MESSAGE_WELCOME",
      button: { type: "next", target: 60 },
      elements: [
        element("reporter_legal_name", "free_text", { character_limit: 1020 }),
        element("reporter_country", "dropdown", countryData),
        element("reported_message_url", "free_text", {
          character_limit: 100,
          pattern:
            "^https://discord\\.com/channels/(\\d{17,20}|@me)/(\\d{17,20})/(\\d{17,20})$"
        })
      ]
    }),
    "60": node(60, {
      key: "URF_MESSAGE_SELECT_REPORT_TYPE",
      children: [["Other", 147]]
    }),
    "147": node(147, {
      key: "URF_MESSAGE_OTHER",
      children: [["Cybercrime", 150]]
    }),
    "150": node(150, {
      key: "URF_MESSAGE_CYBERCRIME",
      button: { type: "next", target: 78 },
      elements: [
        element("dsa_free_text", "free_text", { character_limit: 512 }, false)
      ],
      report_type: "sub_other_cybercrime"
    }),
    "78": node(78, {
      key: "URF_CONFIRMATION_SELECT",
      button: { type: "next", target: 77 },
      elements: [
        element("confirmation_select", "checkbox", [
          ["validation", "I confirm"]
        ])
      ]
    }),
    "77": node(77, {
      key: "URF_SUBMIT",
      button: { type: "submit", target: null }
    }),
    "70": node(70, { key: "URF_SUCCESS" }),
    "74": node(74, { key: "FAIL" })
  };

  return {
    name: "message_urf",
    variant: "1",
    version: "1.0",
    postback_url: "/api/reporting/message_urf",
    root_node_id: 64,
    success_node_id: 70,
    fail_node_id: 74,
    nodes
  };
}

export function createMinimalMenu(flow: ReportFlow): ReportMenu {
  const rootId = flow === "user_urf" ? 63 : flow === "message_urf" ? 64 : 67;
  const categoryId = flow === "guild_urf" ? 155 : 150;
  const nodes: Record<string, MenuNode> = {
    [String(rootId)]: node(rootId, {
      button: { type: "next", target: categoryId }
    }),
    [String(categoryId)]: node(categoryId, {
      report_type: "sub_other_cybercrime",
      button: { type: "next", target: 78 }
    }),
    "78": node(78, {
      key: "URF_CONFIRMATION_SELECT",
      button: { type: "next", target: 77 }
    }),
    "77": node(77, {
      key: "URF_SUBMIT",
      button: { type: "submit", target: null }
    }),
    "70": node(70, { key: "URF_SUCCESS" }),
    "74": node(74, { key: "FAIL" })
  };
  return {
    name: flow,
    variant: "1",
    version: "1.0",
    postback_url: `/api/reporting/${flow}`,
    root_node_id: rootId,
    success_node_id: 70,
    fail_node_id: 74,
    nodes
  };
}
