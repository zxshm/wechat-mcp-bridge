// Offline model: verified identity and user confirmation must come from trusted server-side workflow.
import {newState} from './core.mjs';
const valid = value => typeof value === 'string' && value.length > 0;
export function bindConfirmed({response,ownerSubject,confirmedByOwner,confirmedAt}) {
 if (confirmedByOwner !== true || !valid(ownerSubject) || !Number.isSafeInteger(confirmedAt) || confirmedAt <= 0) throw new Error('Owner confirmation required');
 if (!response || response.status !== 'confirmed' || !valid(response.ilink_user_id) || !valid(response.ilink_bot_id)) throw new Error('Confirmed scanner and bot identifiers required');
 // Deliberately do not accept, retain, or return credentials in this offline model.
 return Object.freeze({ownerSubject,accountScope:response.ilink_bot_id,allowedSender:response.ilink_user_id,confirmedAt});
}
export function armWithChallenge({binding,actor,baselineCursor,challengeCursor,challengeText,message}) {
 if (!binding || actor !== binding.ownerSubject || !valid(binding.accountScope) || !valid(binding.allowedSender)) throw new Error('Confirmed owner binding required');
 if (!valid(baselineCursor) || !valid(challengeCursor) || baselineCursor === challengeCursor || !valid(challengeText)) throw new Error('Trusted baseline and fresh challenge required');
 if (!message || message.from_user_id !== binding.allowedSender || message.chatKind !== 'direct' || message.textOrigin !== 'typed' || (message.group_id !== '' && message.group_id != null) || message.message_type !== 1 || message.message_state !== 2) throw new Error('Challenge must come from bound owner direct text');
 if (!Number.isSafeInteger(message.create_time_ms) || message.create_time_ms <= binding.confirmedAt || !Array.isArray(message.item_list) || message.item_list.length !== 1) throw new Error('Challenge must be new');
 const item=message.item_list[0];
 if (!item || item.type !== 1 || Object.keys(item).some(k => !['type','text_item'].includes(k)) || !item.text_item || Object.keys(item.text_item).some(k => k !== 'text') || item.text_item.text !== challengeText) throw new Error('Challenge mismatch');
 // Challenge is not projected as an event; acceptBatch only admits times strictly after this cutoff.
 return newState({ownerSubject:binding.ownerSubject,accountScope:binding.accountScope,allowFrom:[binding.allowedSender],armedAt:message.create_time_ms,initialCursor:challengeCursor});
}
