import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Send, Mic, MicOff, Bot } from 'lucide-react';
import { api } from '../api/client';
import { Button, Textarea, Card } from '../components/ui';

export default function ChatPage() {
  const navigate = useNavigate();
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<Array<{ role: string; content: string; taskId?: string }>>([]);

  const recogRef = useRef<any>(null);
  const [listening, setListening] = useState(false);
  const speechSupported = typeof window !== 'undefined' && (
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  );

  const handleSend = async () => {
    if (!message.trim() || sending) return;
    const userMsg = message.trim();
    setHistory(prev => [...prev, { role: 'user', content: userMsg }]);
    setMessage('');
    setSending(true);

    try {
      const result = await api.chat(userMsg);
      setHistory(prev => [...prev, {
        role: 'assistant',
        content: `任务已创建，正在规划执行方案...\n任务 ID: ${result.taskId}`,
        taskId: result.taskId,
      }]);
      setTimeout(() => navigate(`/tasks/${result.taskId}`), 600);
    } catch (err: any) {
      setHistory(prev => [...prev, { role: 'assistant', content: `创建任务失败: ${err.message}` }]);
    }
    setSending(false);
  };

  const startVoice = () => {
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = 'zh-CN';
    rec.continuous = false;
    rec.onresult = (e: any) => {
      const t = e.results[0]?.[0]?.transcript || '';
      setMessage(prev => prev ? prev + ' ' + t : t);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    rec.start();
    recogRef.current = rec;
    setListening(true);
  };

  const stopVoice = () => {
    try { recogRef.current?.stop?.(); } catch { /* */ }
    setListening(false);
  };

  return (
    <div className="flex flex-col h-screen animate-fade-in-up">
      <div className="p-6 border-b border-glass-border glass rounded-none">
        <h1 className="text-2xl font-heading font-bold text-fg-primary flex items-center gap-2">
          <Bot className="w-6 h-6 text-brand" /> 对话
        </h1>
        <p className="text-fg-muted mt-1 text-sm">
          用自然语言描述目标，CORAL 自动规划 DAG。提交后会跳转到任务详情页查看进度。
        </p>
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {history.length === 0 && (
          <div className="text-center py-20">
            <div className="w-16 h-16 bg-brand-soft rounded-2xl flex items-center justify-center mx-auto mb-4 border border-brand/30">
              <Sparkles className="w-7 h-7 text-brand" />
            </div>
            <h2 className="text-lg font-heading font-medium text-fg-primary mb-2">欢迎使用 CORAL 智能体平台</h2>
            <p className="text-fg-muted text-sm mb-6">描述你的任务目标，平台会自动分解并并发执行</p>
            <div className="flex flex-wrap justify-center gap-2 max-w-2xl mx-auto">
              {[
                '帮我总结一段文本的核心要点',
                '采集广东工信厅 3 月政策',
                '采集广东工信厅 3 月政策，筛出与公司相关的，做成推文',
                '把这段政策转推文：xxxxx',
              ].map(example => (
                <button
                  key={example}
                  onClick={() => setMessage(example)}
                  className="px-4 py-2 glass border border-glass-border rounded-full text-sm text-fg-secondary hover:border-brand/40 hover:text-brand transition-colors cursor-pointer"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}

        {history.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-2xl rounded-2xl px-5 py-3 ${
              msg.role === 'user'
                ? 'bg-brand text-white'
                : 'glass border border-glass-border text-fg-primary'
            }`}>
              <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
              {msg.taskId && (
                <button
                  onClick={() => navigate(`/tasks/${msg.taskId}`)}
                  className="mt-2 text-xs text-white bg-black/20 px-3 py-1 rounded-full hover:bg-black/30 transition cursor-pointer"
                >
                  查看任务详情 →
                </button>
              )}
            </div>
          </div>
        ))}

        {sending && (
          <div className="flex justify-start">
            <div className="glass rounded-2xl px-5 py-3">
              <div className="flex gap-1">
                <div className="w-2 h-2 bg-fg-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-2 h-2 bg-fg-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-2 h-2 bg-fg-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="p-4 glass border-t border-glass-border rounded-none">
        <div className="max-w-4xl mx-auto flex gap-3 items-end">
          <Textarea
            value={message}
            onChange={e => setMessage(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
            }}
            placeholder="描述你的任务目标..."
            rows={1}
            className="flex-1"
          />
          {speechSupported && (
            <Button
              variant={listening ? 'danger' : 'secondary'}
              onClick={listening ? stopVoice : startVoice}
              icon={listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            >
              {listening ? '停' : '语音'}
            </Button>
          )}
          <Button onClick={handleSend} loading={sending} icon={<Send className="w-4 h-4" />}>发送</Button>
        </div>
      </div>
    </div>
  );
}
