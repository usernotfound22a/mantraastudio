# Logbook 1

## Meeting Details

| Field | Detail |
| --- | --- |
| Logbook | 01 |
| Meeting No. | 01 |
| Date | November 17, 2026 |
| Start Time | ________ |
| End Time | ________ |
| Project | Mantraa Studio |
| Student | Sarthak Ghimire |
| Student ID | 24059230 |
| Supervisor | Sumit Pathak (1st Supervisor) |

## Overview

This logbook records the first meeting for the Mantraa Studio project. The project focuses on an AI-assisted omnichannel inbox that brings customer conversations from multiple channels into one unified workspace. The discussion centered on the research focus, the problem statement, the research objectives and questions, initial findings, the research method, and the main technical and security considerations.

## Items Discussed

- The research focus of the Mantraa Studio project, an AI-assisted omnichannel inbox, was reviewed.
- The problem of scattered customer conversations across multiple channels was discussed.
- The research objectives and research questions were discussed.
- Initial findings on the unified inbox, AI support, real-time updates, and security were presented.
- The research method, a descriptive review of project documentation, was explained.
- Similar customer support platforms were reviewed to identify common features and gaps: Intercom, Zendesk, Freshdesk, HubSpot Service Hub, and Crisp.
- The discussion focused on how Mantraa Studio differs from these products in scope, AI behaviour, channel coverage, security, and deployment.

## Similar Websites and Products Review

To understand the position of Mantraa Studio, five existing customer support platforms were reviewed. These products are useful comparison points because they all provide some form of shared inbox, AI-assisted support, website chat, or omnichannel customer communication. The purpose of the review was not to claim that Mantraa Studio has the same scale as these commercial platforms, but to identify which features are common in the market and which design choices make Mantraa Studio different.

### Comparison Table

| Product | Website | Main features | What is different in Mantraa Studio |
| --- | --- | --- | --- |
| Intercom | [intercom.com/inbox](https://www.intercom.com/inbox) | AI-first customer service, Fin AI Agent, shared inbox, live chat, email, phone support, reporting, knowledge hub, and many integrations. | Mantraa Studio is smaller and research-focused. It concentrates on Messenger, Instagram, and website chat rather than trying to be a complete enterprise support suite. Its AI is FAQ-grounded with a confidence threshold, human handover, and unanswered-question tracking instead of relying only on a general AI agent. |
| Zendesk | [zendesk.com/service/ai/autonomous-service-workforce](https://www.zendesk.com/service/ai/autonomous-service-workforce) | AI agents, agent copilots, workflow automation, governance, messaging, email, voice, backend workflows, and a Resolution Learning Loop. | Mantraa Studio does not attempt to cover enterprise contact-centre operations, voice workflows, or large governance systems. It focuses on a unified inbox for social and website channels, workspace-scoped data, role-based access, and transparent AI handover decisions. |
| Freshdesk | [freshworks.com/freshdesk/omni](https://www.freshworks.com/freshdesk/omni) | Omnichannel support across email, chat, phone, and messaging, with AI agents, AI Copilot, AI Insights, and support analytics. | Mantraa Studio is a lightweight implementation rather than a full help-desk product. Its main difference is the combination of a small channel-adapter architecture, internal notes, FAQ-based assistance, human escalation, and security controls such as RLS and encrypted channel secrets. |
| HubSpot Service Hub | [hubspot.com/products/service](https://www.hubspot.com/products/service) | AI-powered omnichannel service, help desk and ticketing, shared inbox, automation, knowledge base, customer portal, analytics, and deep CRM integration. | Mantraa Studio is not built on a marketing and sales CRM ecosystem. It is an independent customer support workspace where the focus is the conversation inbox, AI assistance from the project's own FAQ knowledge base, tenant isolation, and evaluation of security and privacy behaviour. |
| Crisp | [crisp.chat](https://crisp.chat/) | Website chat widget, shared inbox, Hugo AI Agent, knowledge base, analytics, CRM-style customer views, and all-in-one customer support tools. | Mantraa Studio's widget is a custom embeddable component served by the project API. Unlike an all-in-one commercial platform, Mantraa Studio separates customer identity, workspaces, channels, messages, notes, FAQs, and analytics into a system that can be studied and modified for the research project. |

### Detailed Observations

- **Intercom** is strong in AI automation and multi-channel customer service, but it is a mature commercial product with enterprise-level complexity. Mantraa Studio is different because it remains focused and explainable: messages from the supported channels are normalised into one inbox, and AI replies are based on stored FAQs with a handover path when confidence is low.
- **Zendesk** provides broad service workflows, governance, AI agents, and voice support. Mantraa Studio has a narrower scope, but this allows the project to concentrate on the core research problem: reducing scattered conversations while keeping human agents in control of uncertain or urgent cases.
- **Freshdesk** offers a wide omnichannel help-desk environment. Mantraa Studio differs by being a smaller, modular system where new channels are added through adapters, channel secrets are kept on the server, and the dashboard can show AI confidence, handover reasons, and knowledge gaps.
- **HubSpot Service Hub** connects support with CRM, sales, and marketing data. Mantraa Studio does not depend on a full CRM suite. Its differentiator is that support data, FAQ retrieval, analytics, and role-based workspace access are implemented around the research requirements rather than around a commercial sales platform.
- **Crisp** is close to Mantraa Studio in its use of website chat and a shared inbox. However, Mantraa Studio places stronger emphasis on technical controls: Supabase Auth, row-level security, workspace isolation, signed webhooks, role checks, widget-key rotation, and encrypted channel credentials.

### Main Differences Summary

- **Scope:** Mantraa Studio focuses on Messenger, Instagram, and website chat instead of trying to match every enterprise support channel.
- **AI approach:** The assistant uses FAQ-based retrieval, a confidence gate, human handover, and unanswered-question tracking so that low-confidence answers are not silently sent as facts.
- **Architecture:** Channels are handled through adapters, making the system modular and easier to extend for a research prototype.
- **Security and privacy:** Data access is workspace-scoped with Supabase RLS; webhook signatures, hidden channel secrets, role-based routes, and widget-key rotation are part of the design.
- **Deployment and purpose:** Mantraa Studio is a deployable FYP application built for evaluation and explanation, not a large commercial SaaS platform.

## Goals

- To understand the challenges of managing customer conversations across multiple channels.
- To examine the unified inbox and how AI can support staff while keeping human oversight.
- To identify technical and security considerations of third-party integrations.

## Achievements

- The research problem, objectives, and four research questions were defined.
- The initial research log was completed, covering:
  - omnichannel communication;
  - unified inbox design;
  - AI-assisted support;
  - real-time updates;
  - security considerations.
- The current limits of the work were stated: the review is based on project documentation and publicly available product information, with no interviews or academic literature review completed yet.
- A comparison of five existing customer support platforms was added to identify common features, market expectations, and the design differences of Mantraa Studio.

## Problems

No major problems were encountered. The research is limited to project documentation and publicly available product information. No interviews, hands-on trials of every commercial product, or academic literature review have been completed yet, so the product comparison should be treated as an initial market review rather than a final evaluation.

## Tasks for the Next Meeting

- Research academic papers related to omnichannel support, AI-assisted service, and human handover.
- Validate the initial product comparison through hands-on trials where access is available.
- Define functional and non-functional requirements, including security and privacy.
- Plan how AI assistance, handover behaviour, and security controls will be evaluated.

## Sign-off

| Student | Supervisor |
| --- | --- |
| Sarthak Ghimire | Sumit Pathak (1st Supervisor) |
| 24059230 | |
