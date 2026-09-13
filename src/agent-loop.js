import { BlockAssembler, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'

// These definitions are also the runtime validator. No outer DSH tool can be
// addressed by a name the model invents or by an additional JSON property.
export function tool(name, description, properties = {}) {
  return { name, description, parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } }
}

function argumentsFor(call, tools) {
  const definition = tools.find(item => item.name === call.name)
  if (!definition || typeof call.arguments !== 'string' || Buffer.byteLength(call.arguments) > 2_100_000) throw new Error('Invalid tool call')
  const args = JSON.parse(call.arguments)
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool arguments')
  const properties = definition.parameters.properties
  if (Object.keys(args).some(key => !Object.hasOwn(properties, key))) throw new Error('Unexpected tool argument')
  for (const [key, schema] of Object.entries(properties)) {
    if (typeof args[key] !== schema.type || args[key].length > (schema.maxLength ?? 2_097_152)) throw new Error('Invalid tool argument')
  }
  return args
}

export async function runAgent({ llm, route, system, messages, tools, execute, maxSteps, signal, assertCurrent, progress }) {
  const history = structuredClone(messages)
  let totalBytes = 0
  for (let step = 0; step < maxSteps; step++) {
    signal?.throwIfAborted(); assertCurrent()
    progress?.('thinking')
    const assembler = new BlockAssembler()
    let finish
    for await (const chunk of llm.stream({ ...route, system, messages: structuredClone(history), tools, signal })) {
      signal?.throwIfAborted()
      totalBytes += Buffer.byteLength(JSON.stringify(chunk))
      if (totalBytes > 8_388_608) throw new Error('协作输出超过本轮限制，请缩小任务范围。')
      assembler.push(chunk)
      if (chunk.type === 'finish') finish = chunk.reason
    }
    if (!finish || !['stop', 'tool-calls'].includes(finish.kind)) {
      throw new Error(finish?.failure?.message ?? `模型未完成回答（${finish?.kind ?? 'missing finish'}）。`)
    }
    const blocks = assembler.blocks()
    const calls = blocks.filter(block => block.type === 'tool-call')
    if (calls.length > 16) throw new Error('模型单步请求的工具过多。')
    const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
    history.push(createAssistantMessage({ content: blocks, source: { provider: route.provider, model: route.model } }))
    if (!calls.length) {
      if (finish.kind !== 'stop' || !text.trim()) throw new Error('模型没有给出完整回答。')
      return { messages: history, text }
    }
    if (finish.kind !== 'tool-calls') throw new Error('模型工具调用没有正确结束。')
    for (const call of calls) {
      signal?.throwIfAborted(); assertCurrent()
      let output
      try {
        const args = argumentsFor(call, tools)
        progress?.('tool', call.name)
        output = await execute(call.name, args)
      } catch (error) {
        signal?.throwIfAborted(); assertCurrent()
        // Fixed error: filesystem/provider diagnostics may contain private paths.
        output = { error: 'operation_denied_or_failed' }
      }
      history.push(createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: JSON.stringify(output) }], isError: Boolean(output?.error) }))
    }
  }
  throw new Error('本轮协作已达到步骤上限；已保存的文件保留，请继续发送下一步需求。')
}
