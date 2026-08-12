# Concise Legal-Report Examples Design

## Goal

Guide AI-generated reports to be concise when a message's meaning is obvious, while retaining a short legal explanation that states what the cited provision prohibits and how the content violates it.

## Design

The existing initial writer instruction will distinguish two cases. For direct, plain-language content, it will prohibit unnecessary elaboration and require a concise legal connection. For slang, abbreviations, and coded language, it will preserve the current short meaning explanation before that legal connection.

The synthesis prompt's current generic completed-report placeholder will become two concrete examples. The direct-insult example will show a short report that cites Germany's Criminal Code, Section 185, states that it prohibits insulting another person, and directly relates the quoted profanity to that prohibition. The coded-word example will show a brief definition followed by the same concise law-to-content connection. Both are tone and structure examples only, not reusable facts or legal conclusions.

## Testing and Documentation

Prompt-content tests will assert the explicit obvious-meaning instruction and both examples are included in synthesis input. The bot implementation guide will describe this distinction and the examples.
