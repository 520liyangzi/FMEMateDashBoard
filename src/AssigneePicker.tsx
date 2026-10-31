import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {Check,ChevronDown,Search,X} from 'lucide-react';

type Option={key:string;value:string|undefined;label:string;pinned:boolean};
export type AssigneePickerProps={lang:'zh'|'en';assignees:string[];value?:string;onChange:(value:string|undefined)=>void;disabled?:boolean};

/** Search filters available choices without changing the selected reporting scope. */
export default function AssigneePicker({lang,assignees,value,onChange,disabled=false}:AssigneePickerProps){
  const t=(zh:string,en:string)=>lang==='zh'?zh:en;
  const id=useId(),listId=`${id}-options`,hintId=`${id}-hint`;
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),input=useRef<HTMLInputElement>(null);
  const optionNodes=useRef(new Map<string,HTMLButtonElement>());
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[activeKey,setActiveKey]=useState<string|null>(null),[keyboardMoved,setKeyboardMoved]=useState(false);
  const selectedKey=value===undefined?'overall':`person:${JSON.stringify(value)}`;
  const overallLabel=t('整体（全部处理人）','Overall (all assignees)'),unassignedLabel=t('未分配','Unassigned');
  const selectedLabel=value===undefined?overallLabel:value||unassignedLabel;
  const names=useMemo(()=>{const all=new Set(assignees.filter(name=>typeof name==='string'));if(value!==undefined)all.add(value);return [...all].filter(Boolean).sort((a,b)=>a.localeCompare(b));},[assignees,value]);
  const needle=query.trim().toLowerCase();
  const filtered=useMemo(()=>names.filter(name=>name.toLowerCase().includes(needle)),[names,needle]);
  const hasUnassigned=assignees.includes('')||value==='';
  const options:Option[]=[{key:'overall',value:undefined,label:overallLabel,pinned:true},...(hasUnassigned?[{key:'person:""',value:'',label:unassignedLabel,pinned:true}]:[]),...filtered.map(name=>({key:`person:${JSON.stringify(name)}`,value:name,label:name,pinned:false}))];
  const activeIndex=options.findIndex(option=>option.key===activeKey);
  const activeId=activeIndex<0?undefined:`${listId}-${activeIndex}`;
  useEffect(()=>{
    if(!open)return;
    input.current?.focus();
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target)){setOpen(false);}};
    document.addEventListener('pointerdown',outside);
    return()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  useEffect(()=>{if(open&&activeKey)optionNodes.current.get(activeKey)?.scrollIntoView({block:'nearest'});},[open,activeKey]);
  function show(){if(disabled)return;setQuery('');setActiveKey(selectedKey);setKeyboardMoved(false);setOpen(true);}
  function close(restoreFocus=false){setOpen(false);if(restoreFocus)trigger.current?.focus();}
  function select(option:Option){onChange(option.value);close(true);}
  function move(direction:-1|1){if(!options.length)return;const next=activeIndex<0?(direction===1?0:options.length-1):(activeIndex+direction+options.length)%options.length;setActiveKey(options[next].key);setKeyboardMoved(true);}
  return <div className="assignee-picker" ref={root}>
    <button ref={trigger} type="button" className={'assignee-picker-trigger'+(open?' assignee-picker-open':'')} aria-label={t('MTTR 处理人筛选','MTTR assignee filter')} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} disabled={disabled} onClick={()=>open?close():show()} onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();show();}if(event.key==='Escape')close();}}><span>{selectedLabel}</span><ChevronDown size={15}/></button>
    {open&&<div className="assignee-picker-panel"><div className="assignee-picker-search"><Search size={15}/><input ref={input} type="search" role="combobox" aria-label={t('搜索统计对象','Search assignees')} aria-autocomplete="list" aria-expanded={true} aria-controls={listId} aria-activedescendant={activeId} aria-describedby={hintId} placeholder={t('输入姓名搜索…','Search a name…')} value={query} onChange={event=>{setQuery(event.currentTarget.value);setActiveKey(null);setKeyboardMoved(false);}} onKeyDown={event=>{
      if(event.nativeEvent.isComposing)return;
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();move(event.key==='ArrowDown'?1:-1);}
      else if(event.key==='Enter'){event.preventDefault();const candidate=activeIndex>=0&&(!needle||!options[activeIndex].pinned||keyboardMoved)?options[activeIndex]:needle?options.find(option=>!option.pinned):options.find(option=>option.key===selectedKey);if(candidate)select(candidate);}
      else if(event.key==='Escape'){event.preventDefault();close(true);}
      else if(event.key==='Tab'){close();}
    }}/>{query&&<button type="button" aria-label={t('清空人员搜索','Clear assignee search')} onClick={()=>{setQuery('');setActiveKey(selectedKey);input.current?.focus();}}><X size={13}/></button>}</div>
      <div className="assignee-picker-list" role="listbox" id={listId} aria-label={t('统计对象列表','Reporting scope options')}>
        {options.map((option,index)=><button ref={node=>{if(node)optionNodes.current.set(option.key,node);else optionNodes.current.delete(option.key);}} key={option.key} id={`${listId}-${index}`} type="button" role="option" aria-selected={option.value===value} tabIndex={-1} className={'assignee-picker-option'+(option.pinned?' assignee-picker-pinned':'')+(option.key===activeKey?' assignee-picker-active':'')} onMouseDown={event=>event.preventDefault()} onMouseEnter={()=>{setActiveKey(option.key);setKeyboardMoved(false);}} onClick={()=>select(option)}><span>{option.label}</span>{option.value===value&&<Check size={14}/>}</button>)}
        {needle&&!filtered.length&&<p className="assignee-picker-empty">{t('没有匹配的姓名。可清空搜索或选择整体。','No matching names. Clear the search or choose Overall.')}</p>}
      </div><div className="assignee-picker-hint" id={hintId}>{t('搜索不改变统计；↑ ↓ 选择，Enter 确认，Esc 关闭。','Searching does not change metrics. ↑ ↓ navigate, Enter selects, Esc closes.')}</div>
    </div>}
  </div>;
}
