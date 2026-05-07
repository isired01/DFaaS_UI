import { useState, useRef } from 'react';
import { Upload, FileCode, Check, AlertCircle } from 'lucide-react';
import { uploadK6Script } from '../api/client';

export default function K6FileUpload({ onResult, isReady }) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  const handleFile = async (file) => {
    if (!isReady) return;
    if (!file.name.endsWith('.js')) {
      setError('Il file deve avere estensione .js');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const data = await uploadK6Script(file);
      setUploadedFile(data.filename);
      if (onResult) onResult(data);
    } catch (err) { setError(err.message); }
    finally { setUploading(false); }
  };

  const handleDrop = (e) => { 
    e.preventDefault(); 
    setDragOver(false); 
    if (!isReady) return;
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); 
  };

  return (
    <div
      className={`relative border-2 border-dashed rounded-2xl p-8 text-center transition-all duration-300 
                  ${!isReady ? 'opacity-50 cursor-not-allowed border-surface-700/50 bg-surface-900/30' : 'cursor-pointer'}
                  ${dragOver && isReady ? 'border-dfaas-400 bg-dfaas-500/10' : (!isReady ? '' : 'border-surface-600/50 hover:border-surface-500/50 hover:bg-surface-800/30')}
                  ${uploadedFile && isReady ? 'border-emerald-500/50 bg-emerald-500/5' : ''}`}
      onDragOver={(e) => { e.preventDefault(); if (isReady) setDragOver(true); }}
      onDragLeave={() => { if (isReady) setDragOver(false); }}
      onDrop={handleDrop}
      onClick={() => { if (isReady) fileRef.current?.click(); }}
      id="k6-file-upload-zone"
    >
      <input ref={fileRef} type="file" accept=".js" className="hidden" onChange={(e) => { if (isReady && e.target.files[0]) handleFile(e.target.files[0]); }} disabled={!isReady} />
      
      {uploading ? (
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-3 border-dfaas-500/30 border-t-dfaas-500 rounded-full animate-spin" />
          <p className="text-sm text-surface-400">Uploading...</p>
        </div>
      ) : uploadedFile ? (
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-emerald-500/15 flex items-center justify-center">
            <Check className="w-6 h-6 text-emerald-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-emerald-400">File caricato</p>
            <p className="text-xs text-surface-400 font-mono mt-1">{uploadedFile}</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-surface-800/80 flex items-center justify-center">
            <Upload className="w-6 h-6 text-surface-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-surface-300">Trascina un file .js qui</p>
            <p className="text-xs text-surface-500 mt-1">oppure clicca per selezionare</p>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <span className="text-xs text-red-400">{error}</span>
        </div>
      )}
    </div>
  );
}
